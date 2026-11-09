import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('./test-schema-plan.py', import.meta.url));
const driver = `import copy,importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('schema_plan',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np=json.load(sys.stdin);before=copy.deepcopy(p)\ntry:\n result=m.plan_schema(p['source'],p['target']);assert p==before;print(json.dumps({'sql':result}))\nexcept ValueError as e:\n assert p==before;print(json.dumps({'error':str(e)}))\n`;
function plan(source, target) {
  const p = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c', driver, modulePath], { input: JSON.stringify({ source, target }), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr || p.error?.message);
  return JSON.parse(p.stdout);
}
const col = (type = 'int', overrides = {}) => ({ type, nullable: false, extra: '', comment: '', charset: null, collation: null, ...overrides });
function table(columns = { id: col() }, overrides = {}) {
  const defs = Object.entries(columns).map(([name, c]) => {
    let s = `  \`${name}\` ${c.type}${c.nullable ? '' : ' NOT NULL'}`;
    if (Object.hasOwn(c, 'default')) s += ` DEFAULT ${c.default === null ? 'NULL' : `'${String(c.default).replaceAll("'", "''")}'`}`;
    if (c.extra) s += ` ${c.extra}`;
    if (c.comment) s += ` COMMENT '${c.comment.replaceAll("'", "''")}'`;
    return s;
  });
  return { columns, indexes: [], foreignKeys: [], options: {}, createSQL: `CREATE TABLE \`items\` (\n${defs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`, ...overrides };
}
const schema = t => ({ tables: t ? { items: t } : {} });
const clone = x => structuredClone(x);
function reject(source, target, reason) {
  const r = plan(source, target);
  assert.match(r.error, /结构同步已拒绝/);
  if (reason) assert.match(r.error, reason);
  assert.equal('sql' in r, false, 'must never return a partial SQL plan');
}

test('empty/no-op is pure and unchanged auto_increment/indexes remain supported', () => {
  assert.deepEqual(plan(schema(), schema()), { sql: [] });
  const t = table({ id: col('bigint', { extra: 'auto_increment' }) });
  t.indexes = [{ name: 'PRIMARY', columns: ['id'] }];
  t.createSQL = t.createSQL.replace('\n) ENGINE', ',\n  PRIMARY KEY (`id`)\n) ENGINE');
  assert.deepEqual(plan(schema(t), schema(clone(t))), { sql: [] });
});

test('new table returns original source CREATE only, no business data SQL', () => {
  const t = table();
  assert.deepEqual(plan(schema(t), schema()), { sql: [t.createSQL + ';'] });
  const s = schema(t);
  s.tables.aaa = { ...t, createSQL: t.createSQL.replace('`items`', '`aaa`') };
  assert.deepEqual(plan(s, schema()).sql.map(x => x.split('\n')[0]), ['CREATE TABLE `aaa` (', 'CREATE TABLE `items` (']);
});

test('adds nullable/defaulted ordinary columns in source ordinal order', () => {
  const target = table();
  const source = table({ first: col('int', { default: '0' }), id: col(), label: col('varchar(80)', { nullable: true, default: null, charset: 'utf8mb4', collation: 'utf8mb4_0900_bin' }) });
  // Simulate sort_keys=True snapshot persistence; SHOW CREATE controls order.
  source.columns = Object.fromEntries(Object.entries(source.columns).sort());
  assert.deepEqual(plan(schema(source), schema(target)), { sql: [
    "ALTER TABLE `items` ADD COLUMN `first` int NOT NULL DEFAULT '0' FIRST;",
    'ALTER TABLE `items` ADD COLUMN `label` varchar(80) DEFAULT NULL AFTER `id`;'
  ] });
  reject(schema(table({ id: col(), required: col() })), schema(target), /新增列/);
});

test('permits proven integer widening, sufficient VARCHAR and VARCHAR growth', () => {
  for (const [a, b] of [['tinyint', 'smallint'], ['smallint unsigned', 'int'], ['int', 'bigint'], ['bigint', 'varchar(20)'], ['bigint unsigned', 'varchar(20)'], ['varchar(20)', 'varchar(21)']]) {
    const source = table({ id: col(b) });
    assert.equal(plan(schema(source), schema(table({ id: col(a) }))).sql?.[0], `ALTER TABLE \`items\` MODIFY COLUMN \`id\` ${b} NOT NULL;`, `${a} -> ${b}`);
  }
});

test('unsafe signedness, narrowing, short VARCHAR and unsupported types reject', () => {
  for (const [a, b] of [['int', 'smallint'], ['int', 'bigint unsigned'], ['bigint', 'varchar(19)'], ['bigint unsigned', 'varchar(19)'], ['varchar(20)', 'varchar(19)'], ['varchar(20)', 'int'], ['int', 'float']]) {
    reject(schema(table({ id: col(b) })), schema(table({ id: col(a) })));
  }
});

test('rejects destructive, index/FK/options, hidden constraints and reordered columns', () => {
  reject(schema(), schema(table()), /删除表/);
  reject(schema(table()), schema(table({ id: col(), old: col() })), /删除列/);
  for (const key of ['indexes', 'foreignKeys', 'options']) {
    const t = table();
    t[key] = key === 'options' ? { comment: 'x' } : [{ name: 'x' }];
    reject(schema(t), schema(table()));
  }
  const constraint = table();
  constraint.createSQL = constraint.createSQL.replace('\n) ENGINE', ',\n  CHECK (`id` > 0)\n) ENGINE');
  reject(schema(constraint), schema(table()), /约束/);
  reject(schema(table({ b: col(), a: col() })), schema(table({ a: col(), b: col() })), /重排/);
});

test('rejects generated columns, expressions, unknown/missing metadata and malformed snapshots', () => {
  for (const extra of ['STORED GENERATED', 'VIRTUAL GENERATED', 'DEFAULT_GENERATED', 'on update CURRENT_TIMESTAMP']) {
    const t = table({ id: col('int', { extra }) });
    reject(schema(t), schema(t), /生成列|扩展/);
  }
  for (const mutate of [t => { t.columns.id.untracked = true; }, t => { delete t.columns.id.extra; }, t => { t.untracked = {}; }, t => { t.columns.id.type = 'enum(\'a\',\'b\')'; }]) {
    const t = table(); mutate(t); reject(schema(t), schema());
  }
  for (const s of [null, [], {}, { tables: [] }, { tables: {}, version: 1 }]) reject(s, schema());
});

test('no partial plan escapes when later table is unsafe; no SQL/data text leaks in errors', () => {
  const source = schema(table());
  source.tables.zz = table({ id: col(), secret_column: col('varchar(4)', { default: 'SECRET_VALUE' }) }, { createSQL: 'SECRET_SQL' });
  const result = plan(source, schema());
  assert.match(result.error, /拒绝/);
  assert.doesNotMatch(result.error, /SECRET|secret_column/);
  assert.equal('sql' in result, false);
});

test('rejects multi-statement/CTAS/LIKE/partition SQL and runtime data counters', () => {
  for (const sql of [table().createSQL + '; DELETE FROM `items`', 'CREATE TABLE `items` AS SELECT * FROM `other`', 'CREATE TABLE `items` LIKE `other`', table().createSQL + ' PARTITION BY HASH (`id`)', table().createSQL.replace('ENGINE=InnoDB', 'ENGINE=InnoDB AUTO_INCREMENT=42')]) {
    reject(schema(table(undefined, { createSQL: sql })), schema());
  }
});

test('MySQL ALTER may materialize inherited charset with identical complete metadata', () => {
  const source = table({ id: col(), label: col('varchar(80)', { nullable: true, default: null, charset: 'utf8mb4', collation: 'utf8mb4_0900_bin' }) });
  source.createSQL = source.createSQL.replace('varchar(80)', 'varchar(80) COLLATE utf8mb4_0900_bin');
  const target = clone(source);
  target.createSQL = target.createSQL.replace('varchar(80)', 'varchar(80) CHARACTER SET utf8mb4');
  assert.deepEqual(plan(schema(source), schema(target)), { sql: [] });
});

test('metadata literals must match SQL exactly, including case and syntax-looking text', () => {
  const t = table({ id: col('varchar(80)', { default: 'ABC DEFAULT 1 NULL', comment: 'COMMENT NULL' }) });
  assert.equal(plan(schema(t), schema()).sql?.length, 1);
  t.createSQL = t.createSQL.replace('ABC DEFAULT 1 NULL', 'abc DEFAULT 1 NULL');
  reject(schema(t), schema(), /不一致/);
});

test('changing default/nullability/comment or indexed columns is rejected', () => {
  for (const overrides of [{ default: '0' }, { nullable: true }, { comment: 'changed' }]) {
    reject(schema(table({ id: col('bigint', overrides) })), schema(table()));
  }
  const source = table({ id: col('bigint') }, { indexes: [{ name: 'idx' }] });
  const target = table(undefined, { indexes: [{ name: 'idx' }] });
  reject(schema(source), schema(target), /索引/);
});
