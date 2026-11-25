"""Conservative MySQL 8 schema-only planner; standard library, no database I/O.

plan_schema(source, target) -> list[str], bringing target towards source, or
SchemaPlanError(ValueError). Inputs are trusted, complete metadata snapshots, not
request bodies. Shape (all keys required except column.default):
{tables: {tableName: {createSQL: SHOW_CREATE_TABLE, columns: {columnName: {
 type: COLUMN_TYPE, nullable: bool, default: null|string|int (omit if absent),
 extra: EXTRA, comment: COLUMN_COMMENT, charset: str|null, collation: str|null
}}, indexes: [JSON objects], foreignKeys: [JSON objects], options: {JSON values}}}}

Column order is read from createSQL, not JSON mapping order. SHOW CREATE must be its usual
multiline form, one column/constraint per line. Snapshot collectors must remove
only the table AUTO_INCREMENT counter (not the column attribute). Index/FK/options
objects are opaque, complete, stable metadata: differences are rejected. Unknown
metadata keys, unsupported SQL syntax/types, generated columns, partitioning and
unsafe conversions are rejected even on no-op. This is deliberately NOT a general
MySQL DDL parser, SQL executor, migration runner, or business-data copier.
"""
import json
import re


class SchemaPlanError(ValueError):
    """Safe fixed-text reason; never includes SQL, identifiers or default data."""


def _fail(reason):
    raise SchemaPlanError("结构同步已拒绝：" + reason)


def _keys(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or set(value) - set(required) - set(optional):
        _fail("元数据字段缺失或不受支持")


def _name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", value):
        _fail("标识符不受支持")
    return "`" + value + "`"


_BITS = {"tinyint": 8, "smallint": 16, "mediumint": 24, "int": 32, "bigint": 64}


def _type(value):
    if not isinstance(value, str):
        _fail("列类型元数据不受支持")
    value = value.lower()
    match = re.fullmatch(r"(tinyint|smallint|mediumint|int|bigint)(?:\([0-9]+\))?( unsigned)?", value)
    if match:
        return ("int", _BITS[match[1]], bool(match[2]))
    match = re.fullmatch(r"varchar\(([1-9][0-9]*)\)", value)
    if match and int(match[1]) <= 16383:
        return ("varchar", int(match[1]))
    if value in ('tinyblob', 'blob', 'mediumblob', 'longblob'):
        return ('other', value)
    match = re.fullmatch(r'(binary|varbinary)\(([1-9][0-9]*)\)', value)
    if match and int(match[2]) <= (255 if match[1] == 'binary' else 65535):
        return ('other', value)
    match = re.fullmatch(r'decimal\(([1-9][0-9]?),([0-9]{1,2})\)', value)
    if match and int(match[1]) <= 65 and int(match[2]) <= min(30, int(match[1])):
        return ('other', value)
    match = re.fullmatch(r'char\(([1-9][0-9]*)\)', value)
    if match and int(match[1]) <= 255:
        return ('other', value)
    # These ordinary types can remain unchanged or be added, never converted.
    if re.fullmatch(r"(?:date|datetime(?:\([0-6]\))?|timestamp(?:\([0-6]\))?|time(?:\([0-6]\))?|text|mediumtext|longtext|json)", value):
        return ("other", value)
    _fail("列类型不受支持，无法证明安全")


def _safe_type(old, new):
    a, b = _type(old), _type(new)
    if old == new:
        return True
    if a[0] == b[0] == "int":
        lo = 0 if a[2] else -(2 ** (a[1] - 1))
        hi = 2 ** (a[1] if a[2] else a[1] - 1) - 1
        blo = 0 if b[2] else -(2 ** (b[1] - 1))
        bhi = 2 ** (b[1] if b[2] else b[1] - 1) - 1
        return b[1] > a[1] and blo <= lo and hi <= bhi
    if a[0] == "int" and b[0] == "varchar":
        low = 0 if a[2] else -(2 ** (a[1] - 1))
        high = 2 ** (a[1] if a[2] else a[1] - 1) - 1
        return b[1] >= max(len(str(low)), len(str(high)))
    return a[0] == b[0] == "varchar" and b[1] >= a[1]


def _literal(value):
    if value is None:
        return "NULL"
    if type(value) is int:
        return "'" + str(value) + "'"
    if type(value) is not str or any(c in value for c in "\\\x00\r\n"):
        _fail("默认值或注释不受支持")
    return "'" + value.replace("'", "''") + "'"


def _column(column):
    _keys(column, ("type", "nullable", "extra", "comment", "charset", "collation"), ("default",))
    _type(column["type"])
    if type(column["nullable"]) is not bool or column["extra"] not in ("", "auto_increment"):
        _fail("生成列或扩展列元数据不受支持")
    if not isinstance(column["comment"], str):
        _fail("注释元数据不受支持")
    sql = column["type"]
    for key, keyword in (("charset", " CHARACTER SET "), ("collation", " COLLATE ")):
        value = column[key]
        if value is not None:
            _name(value)
            sql += keyword + value
    sql += " NULL" if column["nullable"] else " NOT NULL"
    if "default" in column:
        if column["default"] is None and not column["nullable"]:
            _fail("非空列不能使用空默认值")
        sql += " DEFAULT " + _literal(column["default"])
    if column["extra"]:
        sql += " AUTO_INCREMENT"
    if column["comment"]:
        sql += " COMMENT " + _literal(column["comment"])
    return sql


def _without_literals(sql):
    # SQL strings with doubled quotes; backslash escaping is deliberately refused.
    return re.sub(r"'(?:[^'\\]|'')*'|`(?:[^`]|``)*`", "?", sql)


def _table(name, table, unchanged=False):
    _name(name)
    _keys(table, ("createSQL", "columns", "indexes", "foreignKeys", "options"))
    if type(table["columns"]) is not dict or not table["columns"]:
        _fail("列元数据必须为非空有序对象")
    if any(type(table[k]) is not list for k in ("indexes", "foreignKeys")) or type(table["options"]) is not dict:
        _fail("索引外键或表选项元数据不受支持")
    try:
        json.dumps(table, allow_nan=False)
    except (TypeError, ValueError):
        _fail("元数据必须为普通JSON值")
    for col, metadata in table["columns"].items():
        _name(col)
        if unchanged and type(metadata) is dict and metadata.get("extra") in ("STORED GENERATED", "VIRTUAL GENERATED"):
            ordinary = dict(metadata, extra="")
            _column(ordinary)
        else:
            _column(metadata)
    sql = table["createSQL"]
    if not isinstance(sql, str) or "\\" in sql or "\x00" in sql:
        _fail("建表SQL格式不受支持")
    sql = sql.strip().removesuffix(";")
    masked = _without_literals(sql)
    statement_mask = re.sub(r"\bON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE|SET NULL|NO ACTION)\b", "", masked, flags=re.I)
    if any(token in masked for token in (";", "--", "/*", "#")) or re.search(r"\b(SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|PARTITION|LIKE|TABLESPACE)\b", statement_mask, re.I):
        _fail("建表SQL含不支持或非结构语句")
    lines = sql.splitlines()
    if len(lines) < 3 or lines[0] != "CREATE TABLE " + _name(name) + " (" or not lines[-1].startswith(") ENGINE=InnoDB "):
        _fail("仅支持标准多行InnoDB建表SQL")
    if not re.fullmatch(r"\) ENGINE=InnoDB(?: DEFAULT CHARSET=[A-Za-z0-9_]+)?(?: COLLATE=[A-Za-z0-9_]+)?(?: COMMENT='(?:[^'\\]|'')*')?", lines[-1]):
        _fail("表选项或运行时自增计数不受支持")
    definitions, rest = {}, []
    for line in lines[1:-1]:
        line = line.strip().removesuffix(",")
        match = re.match(r"`([A-Za-z_][A-Za-z0-9_]*)` (.+)$", line)
        if match:
            col, definition = match.groups()
            if col in definitions or col not in table["columns"]:
                _fail("建表SQL与列元数据不一致")
            # Unchanged generated definitions are never emitted as executable SQL.
            if unchanged and table["columns"][col]["extra"] in ("STORED GENERATED", "VIRTUAL GENERATED"):
                if " GENERATED ALWAYS AS " not in definition.upper():
                    _fail("生成列定义与元数据不一致")
                definitions[col] = definition
                continue
            # SHOW CREATE may omit explicit NULL and emit unquoted numeric defaults.
            expected = _column(table["columns"][col])
            def normalized(value):
                # Protect literals before normalizing syntax: their exact bytes matter.
                literals = []
                def protect(match):
                    literals.append(match.group(0))
                    return "\x01" + str(len(literals) - 1) + "\x02"
                value = re.sub(r"'(?:[^'\\\\]|'')*'", protect, value)
                for token, keyword in (("CHARSET", "CHARACTER SET"), ("COLLATE", "COLLATE")):
                    inherited = re.search(r"\b" + token + r"=([A-Za-z0-9_]+)", lines[-1])
                    if inherited:
                        value = re.sub(r" " + keyword + r" " + re.escape(inherited[1]) + r"\b", "", value, flags=re.I)
                value = re.sub(r"(?<!NOT)(?<!DEFAULT) NULL(?= DEFAULT| COMMENT|$)", "", value, flags=re.I)
                metadata = table["columns"][col]
                if metadata["nullable"] and metadata.get("default") is None and metadata["type"].lower() in ("tinyblob", "blob", "mediumblob", "longblob", "text", "mediumtext", "longtext", "json"):
                    value = re.sub(r" DEFAULT NULL(?= COMMENT|$)", "", value, flags=re.I)
                value = value.lower()
                value = re.sub(r"\x01([0-9]+)\x02", lambda m: literals[int(m[1])], value)
                return re.sub(r"default (-?[0-9]+(?:\.[0-9]+)?)(?= |$)", r"default '\1'", value)
            if normalized(expected) != normalized(definition):
                _fail("建表SQL与列元数据不一致或列语法不受支持")
            definitions[col] = definition
        elif re.match(r"(?:PRIMARY KEY |UNIQUE KEY |KEY |CONSTRAINT |CHECK |FULLTEXT KEY |SPATIAL KEY )", line):
            rest.append(line)
        else:
            _fail("表约束语法不受支持")
    if set(definitions) != set(table["columns"]):
        _fail("列顺序或列元数据不完整")
    return definitions, rest, lines[-1]


def _unchanged_table(name, source, target):
    if source == target:
        return True
    if type(source) is not dict or type(target) is not dict:
        return False
    if {k: v for k, v in source.items() if k != 'createSQL'} != {k: v for k, v in target.items() if k != 'createSQL'}:
        return False
    # Ordinary definitions are independently validated against identical metadata.
    # Generated expressions, column order and constraints must still match exactly.
    a, b = _table(name, source, True), _table(name, target, True)
    return (list(a[0]) == list(b[0]) and a[1:] == b[1:] and all(
        a[0][col] == b[0][col] for col, metadata in source['columns'].items()
        if metadata['extra'] in ('STORED GENERATED', 'VIRTUAL GENERATED')))


# Diagnostics are a separate, read-only projection, never a planner input or SQL.
_REVIEW_REASONS = {
    "TARGET_ONLY_TABLE": "目标独有表，禁止自动删除",
    "COLUMN_TYPE_MISMATCH": "列类型不一致",
    "MISSING_COLUMN": "目标缺少源列",
    "DROPPED_COLUMN": "目标列在源中不存在，禁止自动删除",
    "INDEX_DIFFERENCE": "索引结构不一致",
    "FOREIGN_KEY_DIFFERENCE": "外键结构不一致",
    "UNSUPPORTED_TYPE": "列类型不受支持",
    "UNSUPPORTED_METADATA": "元数据或结构差异不受支持",
}


def _review_name(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", value) is not None


def _review_type(value):
    """Return only canonical allowlisted type syntax; never copy arbitrary text."""
    if not isinstance(value, str) or len(value) > 128:
        return None
    value = value.lower()
    match = re.fullmatch(r"(tinyint|smallint|mediumint|int|bigint)(?:\([0-9]{1,3}\))?( unsigned)?", value)
    if match:
        return match[1] + (" unsigned" if match[2] else "")
    match = re.fullmatch(r"(varchar|char)\(([1-9][0-9]{0,4})\)", value)
    if match:
        size = int(match[2])
        if size <= (16383 if match[1] == "varchar" else 255):
            return match[1] + "(" + str(size) + ")"
        return None
    match = re.fullmatch(r"decimal\(([1-9][0-9]?),([0-9]{1,2})\)", value)
    if match:
        precision, scale = int(match[1]), int(match[2])
        if precision <= 65 and scale <= min(30, precision):
            return "decimal(" + str(precision) + "," + str(scale) + ")"
        return None
    if re.fullmatch(r"date|datetime(?:\([0-6]\))?|timestamp(?:\([0-6]\))?|time(?:\([0-6]\))?|text|mediumtext|longtext|json", value):
        return value
    return None


def review_details(source, target) -> list:
    """Bounded safe diagnostics: target is old/test; source is desired/dev.

    Call on planner refusal. Differences listed here do not grant permission to
    migrate: the unchanged planner remains the sole safety decision. No SQL,
    defaults, comments, index/FK payloads or exception text leave this function.
    """
    result = []

    def add(code, table=None, column=None, from_type=None, to_type=None):
        if len(result) >= 12:
            return
        entry = {"code": code, "reason": _REVIEW_REASONS[code]}
        if _review_name(table):
            entry["table"] = table
            if _review_name(column):
                entry["column"] = column
        if from_type is not None:
            entry["fromType"] = from_type
        if to_type is not None:
            entry["toType"] = to_type
        if entry not in result:
            result.append(entry)

    for snapshot in (source, target):
        if type(snapshot) is not dict or set(snapshot) != {"tables"} or type(snapshot["tables"]) is not dict:
            add("UNSUPPORTED_METADATA")
            return result
    src, dst = source["tables"], target["tables"]
    if any(not _review_name(name) for name in set(src) | set(dst)):
        add("UNSUPPORTED_METADATA")
    names = sorted(name for name in set(src) | set(dst) if _review_name(name))
    for name in names:
        if len(result) >= 12:
            break
        if name not in src:
            add("TARGET_ONLY_TABLE", name)
        tables = [snapshot[name] for snapshot in (src, dst) if name in snapshot]
        columns = []
        for table in tables:
            if type(table) is not dict or type(table.get("columns")) is not dict:
                add("UNSUPPORTED_METADATA", name)
                columns.append({})
                continue
            cols = table["columns"]
            columns.append(cols)
            for column in sorted(c for c in cols if _review_name(c)):
                metadata = cols[column]
                if type(metadata) is not dict:
                    add("UNSUPPORTED_METADATA", name, column)
                else:
                    try:
                        _type(metadata.get("type"))
                    except ValueError:
                        add("UNSUPPORTED_TYPE", name, column)
            # Reuse the planner's complete metadata/SQL validation, but never its
            # exception text. Invalid identifiers are represented only by fallback.
            try:
                _table(name, table, name in src and name in dst and _unchanged_table(name, src[name], dst[name]))
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                add("UNSUPPORTED_METADATA", name)
        if name not in src or name not in dst:
            if name in src and type(src[name]) is dict and src[name].get("foreignKeys"):
                add("FOREIGN_KEY_DIFFERENCE", name)
            continue
        desired, current = src[name], dst[name]
        if not all(type(t) is dict for t in (desired, current)):
            continue
        sc, tc = columns
        for column in sorted(c for c in set(sc) | set(tc) if _review_name(c)):
            if len(result) >= 12:
                break
            new = sc.get(column)
            old = tc.get(column)
            to_type = _review_type(new.get("type")) if type(new) is dict else None
            from_type = _review_type(old.get("type")) if type(old) is dict else None
            if column not in tc:
                add("MISSING_COLUMN", name, column, to_type=to_type)
            elif column not in sc:
                add("DROPPED_COLUMN", name, column, from_type=from_type)
            elif from_type is not None and to_type is not None and from_type != to_type:
                add("COLUMN_TYPE_MISMATCH", name, column, from_type, to_type)
            elif new != old:
                add("UNSUPPORTED_METADATA", name, column)
        for key, code in (("indexes", "INDEX_DIFFERENCE"), ("foreignKeys", "FOREIGN_KEY_DIFFERENCE"), ("options", "UNSUPPORTED_METADATA")):
            if desired.get(key) != current.get(key):
                add(code, name)
        # Covers rejected constraint/order/SQL differences not exposed above.
        if desired != current and not any(entry.get("table") == name for entry in result):
            try:
                plan_schema({"tables": {name: desired}}, {"tables": {name: current}})
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                add("UNSUPPORTED_METADATA", name)
    return result


def _new_table_dependencies(name, table, source, parsed):
    """Validate complete FK metadata against SHOW CREATE before ordering new tables."""
    groups = {}
    for fk in table["foreignKeys"]:
        _keys(fk, ("name", "position", "column", "table", "target", "update", "delete", "match"))
        for key in ("name", "column", "table", "target"):
            _name(fk[key])
        if type(fk["position"]) is not int or fk["position"] < 1 or fk["match"] != "NONE":
            _fail("新增表外键元数据不受支持")
        if any(fk[k] not in ("NO ACTION", "RESTRICT", "CASCADE", "SET NULL") for k in ("update", "delete")):
            _fail("新增表外键动作不受支持")
        groups.setdefault(fk["name"], []).append(fk)
    expected, dependencies = [], set()
    for constraint, entries in sorted(groups.items()):
        entries = sorted(entries, key=lambda x: x["position"])
        first = entries[0]
        if [x["position"] for x in entries] != list(range(1, len(entries) + 1)) or any(
                any(x[k] != first[k] for k in ("table", "update", "delete")) for x in entries):
            _fail("新增表复合外键元数据不一致")
        parent = source.get(first["table"])
        if parent is None:
            _fail("新增表外键引用表缺失")
        for entry in entries:
            child_col = table["columns"].get(entry["column"])
            parent_col = parent["columns"].get(entry["target"])
            if child_col is None or parent_col is None or any(child_col[k] != parent_col[k] for k in ("type", "charset", "collation")):
                _fail("新增表外键列不兼容")
            if "SET NULL" in (first["update"], first["delete"]) and not child_col["nullable"]:
                _fail("新增表外键置空与非空列冲突")
        child = ",".join(_name(x["column"]) for x in entries)
        parent_cols = ",".join(_name(x["target"]) for x in entries)
        line = "CONSTRAINT " + _name(constraint) + " FOREIGN KEY (" + child + ") REFERENCES " + _name(first["table"]) + " (" + parent_cols + ")"
        # MySQL omits the default NO ACTION but retains explicit RESTRICT.
        for key in ("delete", "update"):
            if first[key] != "NO ACTION":
                line += " ON " + key.upper() + " " + first[key]
        expected.append(line)
        if first["table"] != name:
            dependencies.add(first["table"])
    actual = [line for line in parsed[1] if "FOREIGN KEY" in _without_literals(line).upper()]
    normalize = lambda line: re.sub(r"\s*,\s*", ",", line)
    if sorted(map(normalize, actual)) != sorted(map(normalize, expected)):
        _fail("新增表外键SQL与元数据不一致")
    return dependencies


def _column_dependencies(name, column, tables, parsed):
    """Fail closed for incomplete/expression metadata and any affected constraint."""
    table = tables[name]
    for index in table["indexes"]:
        if type(index) is not dict or not isinstance(index.get("column"), str) or index.get("expression", "unknown") is not None or index["column"] == column:
            return True
    for line in parsed[1]:
        if "FOREIGN KEY" in _without_literals(line).upper():
            continue
        if not re.match(r"(?:PRIMARY KEY |UNIQUE KEY |KEY )", line):
            return True
        # Ignore the index name but not indexed column identifiers.
        body = line[line.index("("):] if "(" in line else line
        if _name(column) in body:
            return True
    for owner, candidate in tables.items():
        for fk in candidate["foreignKeys"]:
            if type(fk) is not dict or not all(isinstance(fk.get(k), str) for k in ("column", "table", "target")):
                return True
            if (owner == name and fk["column"] == column) or (fk["table"] == name and fk["target"] == column):
                return True
    return False


def plan_schema(source, target):
    """Return deterministic DDL only; fail atomically without returning partial SQL."""
    _keys(source, ("tables",))
    _keys(target, ("tables",))
    for snapshot in (source, target):
        if type(snapshot["tables"]) is not dict:
            _fail("表元数据必须为对象")
    src, dst = source["tables"], target["tables"]
    unchanged = {name for name in src.keys() & dst.keys() if _unchanged_table(name, src[name], dst[name])}
    parsed_source = {name: _table(name, table, name in unchanged) for name, table in src.items()}
    parsed_target = {name: _table(name, table, name in unchanged) for name, table in dst.items()}
    if set(dst) - set(src):
        _fail("禁止删除表")
    result = []
    for name in sorted(src):
        desired = src[name]
        if name not in dst or name in unchanged:
            continue
        current = dst[name]
        for key, reason in (("indexes", "索引差异禁止自动同步"), ("foreignKeys", "外键差异禁止自动同步"), ("options", "表选项差异不受支持")):
            if desired[key] != current[key]:
                _fail(reason)
        sdefs, srest, stail = parsed_source[name]
        tdefs, trest, ttail = parsed_target[name]
        if srest != trest or stail != ttail:
            _fail("存在未支持的约束或表结构差异")
        sc, tc = desired["columns"], current["columns"]
        if set(tc) - set(sc):
            _fail("禁止删除列")
        if [c for c in sdefs if c in tc] != list(tdefs):
            _fail("既有列重排不受支持")
        previous = None
        for col in sdefs:
            column = sc[col]
            if col not in tc:
                if column["extra"] or (not column["nullable"] and ("default" not in column or column["default"] is None)):
                    _fail("新增列必须为可空或有默认值的普通列")
                position = " FIRST" if previous is None else " AFTER " + _name(previous)
                result.append("ALTER TABLE " + _name(name) + " ADD COLUMN " + _name(col) + " " + sdefs[col] + position + ";")
            # Both SQL definitions already validated against complete metadata.
            # MySQL SHOW CREATE may materialize inherited CHARACTER SET after ALTER.
            elif column != tc[col]:
                old = tc[col]
                if column["extra"] or old["extra"] or _column_dependencies(name, col, src, parsed_source[name]) or _column_dependencies(name, col, dst, parsed_target[name]):
                    _fail("带索引外键或扩展属性的列不支持自动修改")
                # Changing integer to text necessarily introduces charset metadata.
                ignore = {"type", "comment"}
                if _type(old["type"])[0] == "int" and _type(column["type"])[0] == "varchar":
                    ignore |= {"charset", "collation"}
                if any(column.get(k) != old.get(k) or (k in column) != (k in old) for k in set(column) | set(old) if k not in ignore) or not _safe_type(old["type"], column["type"]):
                    _fail("列变更无法证明无损安全")
                if column["type"] == old["type"]:
                    _fail("列SQL存在未解释差异")
                result.append("ALTER TABLE " + _name(name) + " MODIFY COLUMN " + _name(col) + " " + sdefs[col] + ";")
            previous = col
    # Existing-table alterations run first, so referenced added columns exist.
    pending = {name: _new_table_dependencies(name, src[name], src, parsed_source[name])
               for name in sorted(src.keys() - dst.keys())}
    available = set(dst)
    while pending:
        ready = sorted(name for name, deps in pending.items() if deps <= available)
        if not ready:
            _fail("新增表存在循环外键依赖，需人工迁移")
        for name in ready:
            result.append(src[name]["createSQL"].strip().removesuffix(";") + ";")
            available.add(name)
            del pending[name]
    return result
