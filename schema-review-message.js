// Strict structural diagnostics only: never echo server reasons, SQL or row values.
const labels = Object.freeze({TARGET_ONLY_TABLE:'test 存在 dev 没有的旧表，安全结构同步不自动移除旧表',COLUMN_TYPE_MISMATCH:'字段类型不同，当前安全同步规则无法证明转换兼容',MISSING_COLUMN:'test 缺少目标字段',DROPPED_COLUMN:'test 存在目标已移除的字段',INDEX_DIFFERENCE:'索引或主键定义不同',FOREIGN_KEY_DIFFERENCE:'外键关联定义不同',UNSUPPORTED_TYPE:'字段类型不在自动同步支持范围',UNSUPPORTED_METADATA:'结构定义包含未支持的差异'});
const ident = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const safeType = value => typeof value === 'string' && /^(?:(?:tinyint|smallint|mediumint|int|bigint)(?:\([0-9]{1,3}\))?(?: unsigned)?|(?:var)?char\([0-9]{1,5}\)|decimal\([0-9]{1,2},[0-9]{1,2}\)|(?:datetime|timestamp|time)(?:\([0-6]\))?|date|text|mediumtext|longtext|json|float|double|boolean|bit\([0-9]{1,2}\))$/.test(value);
const header='数据库结构差异需要人工审查，未执行 SQL、未删除数据。';
const footer='本次结构同步已停止，仅展示原因，不执行自动处理。';
function line(item) {
  if (!item || !Object.hasOwn(labels,item.code) || Object.keys(item).some(k=>!['code','reason','table','column','fromType','toType'].includes(k)) || (item.table!==undefined&&!ident(item.table)) || (item.column!==undefined&&!ident(item.column)) || (item.fromType!==undefined&&!safeType(item.fromType)) || (item.toType!==undefined&&!safeType(item.toType))) return;
  return (item.table||'结构检查')+(item.column?'.'+item.column:'')+'：'+labels[item.code]+(item.fromType&&item.toType?'（test '+item.fromType+' → dev '+item.toType+'）':'');
}
export function schemaReviewMessage(text) {
  if(typeof text!=='string'||text.length>65536)return;
  if(text.startsWith('SCHEMA_REVIEW_V1:')) {
    try {
      const data=JSON.parse(text.slice('SCHEMA_REVIEW_V1:'.length));
      if(typeof data.force!=='boolean'||!Array.isArray(data.details)||!data.details.length||data.details.length>12)return;
      const lines=data.details.map(line);if(lines.some(x=>!x))return;
      return [header,...lines,footer].join('\n');
    }catch{return;}
  }
  if(!text.startsWith(header+'\n'))return;
  const lines=text.split('\n');if(lines.length<3||lines.length>14||lines.at(-1)!==footer)return;
  // Only accept exact known labels and independently validated identifiers/types.
  for(const value of lines.slice(1,-1)) {
    const match=value.match(/^([A-Za-z_][A-Za-z0-9_]{0,63})(?:\.([A-Za-z_][A-Za-z0-9_]{0,63}))?：(.+)$/);if(!match)return;
    let rest=match[3];const types=rest.match(/（test (.+) → dev (.+)）$/);
    if(types){if(!safeType(types[1])||!safeType(types[2]))return;rest=rest.slice(0,types.index);}
    if(!Object.values(labels).includes(rest))return;
  }
  return text;
}
