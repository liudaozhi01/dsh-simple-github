import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('./test-schema-plan.py', import.meta.url));
const driver = `import copy,importlib.util,json,sys
spec=importlib.util.spec_from_file_location('schema_plan',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.load(sys.stdin);before=copy.deepcopy(p)
r=m.review_details(p['source'],p['target']);assert p==before
print(json.dumps(r))
`;
function review(source, target) {
  const p = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c', driver, modulePath], { input: JSON.stringify({ source, target }), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr || p.error?.message);
  return JSON.parse(p.stdout);
}
const col = (type = 'int', extra = {}) => ({ type, nullable: false, extra: '', comment: '', charset: null, collation: null, ...extra });
function table(name, columns = { id: col() }, extra = {}) {
  const defs = Object.entries(columns).map(([key, value]) => `  \`${key}\` ${value.type} NOT NULL`);
  return { columns, indexes: [], foreignKeys: [], options: {}, createSQL: `CREATE TABLE \`${name}\` (\n${defs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, ...extra };
}
const schema = tables => ({ tables });
const detail = (code, reason, extra = {}) => ({ code, reason, ...extra });

test('diagnostics preserve dev/source new versus test/target old types and identifiers', () => {
  const dev = schema({ oa_record: table('oa_record', { owner_id: col('VARCHAR(36)'), count: col('BIGINT') }) });
  const target = schema({ oa_record: table('oa_record', { owner_id: col('BIGINT'), count: col('INT(11) UNSIGNED') }) });
  assert.deepEqual(review(dev, target), [
    detail('COLUMN_TYPE_MISMATCH', '列类型不一致', { table: 'oa_record', column: 'count', fromType: 'int unsigned', toType: 'bigint' }),
    detail('COLUMN_TYPE_MISMATCH', '列类型不一致', { table: 'oa_record', column: 'owner_id', fromType: 'bigint', toType: 'varchar(36)' }),
  ]);
  assert.deepEqual(review(target, dev).map(({ fromType, toType }) => [fromType, toType]), [['bigint', 'int unsigned'], ['varchar(36)', 'bigint']]);
});

test('target-only tables, missing and dropped columns, index/FK differences use fixed codes', () => {
  const dev = schema({ items: table('items', { id: col(), added: col('varchar(36)') }, { indexes: [{ name: 'PRIVATE_INDEX' }], foreignKeys: [{ sql: 'PRIVATE_FK' }] }) });
  const target = schema({ items: table('items', { id: col(), removed: col('bigint') }), stale: table('stale') });
  assert.deepEqual(review(dev, target), [
    detail('MISSING_COLUMN', '目标缺少源列', { table: 'items', column: 'added', toType: 'varchar(36)' }),
    detail('DROPPED_COLUMN', '目标列在源中不存在，禁止自动删除', { table: 'items', column: 'removed', fromType: 'bigint' }),
    detail('INDEX_DIFFERENCE', '索引结构不一致', { table: 'items' }),
    detail('FOREIGN_KEY_DIFFERENCE', '外键结构不一致', { table: 'items' }),
    detail('TARGET_ONLY_TABLE', '目标独有表，禁止自动删除', { table: 'stale' }),
  ]);
});

test('output cap is deterministic, at most 12 entries, and no snapshot mutation occurs', () => {
  const cols = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c_${String(i).padStart(2, '0')}`, col('bigint')]));
  const old = Object.fromEntries(Object.keys(cols).map(key => [key, col('int')]));
  const result = review(schema({ items: table('items', cols) }), schema({ items: table('items', old) }));
  assert.equal(result.length, 12);
  assert.deepEqual(result.map(x => x.column), Object.keys(cols).slice(0, 12));
});

test('SQL/default/comment/rows, invalid identifiers and unsupported types never leak', () => {
  const secret = 'NEVER_ECHO_SECRET';
  const dirty = table('items', {
    id: col(`enum('${secret}')`, { default: secret, comment: secret }),
    [`bad-${secret}`]: col('int'),
  }, { createSQL: `SELECT '${secret}'`, rows: [{ password: secret }], indexes: [{ name: secret }] });
  const source = schema({ items: dirty, [`bad-${secret}`]: dirty });
  const result = review(source, schema({ items: table('items') }));
  assert.ok(result.some(x => x.code === 'UNSUPPORTED_TYPE' && x.column === 'id'));
  assert.ok(result.some(x => x.code === 'UNSUPPORTED_METADATA'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|SELECT|enum|password|bad-`));
  assert.ok(result.every(x => Object.keys(x).every(key => ['code', 'reason', 'table', 'column', 'fromType', 'toType'].includes(key))));
});

test('strict allowlist rejects malicious or unsupported type strings without partial type echo', () => {
  for (const type of ['float', "varchar(36) COMMENT 'HIDDEN'", 'int; SELECT HIDDEN', 'enum(\'HIDDEN\')', 'varchar(99999)', 'decimal(99,98)', 'char(256)', {}, null]) {
    const result = review(schema({ items: table('items', { id: col(type) }) }), schema({ items: table('items') }));
    assert.ok(result.some(x => x.code === 'UNSUPPORTED_TYPE'), JSON.stringify(type));
    assert.ok(result.every(x => !Object.hasOwn(x, 'toType')));
    assert.doesNotMatch(JSON.stringify(result), /HIDDEN|float|enum|99999|99,98|char\(256\)/);
  }
});

test('malformed and unsupported metadata produce safe fallback, unchanged schema stays empty', () => {
  for (const value of [null, [], {}, { tables: [] }, { tables: {}, rows: 'HIDDEN' }]) {
    assert.deepEqual(review(value, schema({})), [detail('UNSUPPORTED_METADATA', '元数据或结构差异不受支持')]);
  }
  for (const value of [null, {}, { columns: null }, { columns: { id: null } }]) {
    assert.ok(review(schema({ items: value }), schema({ items: table('items') })).some(x => x.code === 'UNSUPPORTED_METADATA'));
  }
  const t = table('items');
  assert.deepEqual(review(schema({ items: t }), schema({ items: structuredClone(t) })), []);
  t.columns.id.extra = 'STORED GENERATED';
  assert.ok(review(schema({ items: t }), schema({ items: t })).some(x => x.code === 'UNSUPPORTED_METADATA'));
});
