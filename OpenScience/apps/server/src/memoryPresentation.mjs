/** The copy boundary accepts a complete expression with closed slots. No free
 * label, number, entity or example can be interpolated into the output. The
 * match is the original statement, including its scope, never a paraphrase. */
const zhFormat = '(?:用|使用|采用)(?:表格|三栏表|两栏表|项目符号|列表|短句|中文|英文|英语|中英双语)(?:展示|呈现|回答|回复|写)?';
const zhOrder = '(?:先(?:写|给|说)?结论[，、]?(?:再|后)(?:写|给|说|列)?(?:依据|证据|理由|细节)|先摘要[，、]?后正文)';
const zhTable = '(?:(?:数字|数值|小数)?(?:统一)?保留[一两二三四0-4]位小数|列顺序(?:按|用)(?:日期[、，]名称[、，]备注|项目[、，]说明[、，]备注))';
const zhTone = '(?:(?:语气|措辞)(?:要|请)?(?:正式|客观|中性|温和)(?:点|一点)?|(?:说|写|回答|回复)(?:得)?(?:简短|简洁|简明)(?:些|点|一点)?)';
const zh = new RegExp(`^(?:我的表达偏好是[：:]?)?(?:我(?:希望|喜欢|要求))?(以后|今后|往后|每次|默认)?(?:的)?(?:所有)?(?:报告|回答|回复|摘要|表格)?(?:都)?(?:请)?(?:${zhFormat}|${zhOrder}|${zhTable}|${zhTone})[。！!]?$`, 'u');
const en = /^(?:(from now on|always|by default)\s*[,]?\s*)?(?:please )?(?:use (?:tables|bullet points|short sentences|a formal tone|a neutral tone|English|Chinese)(?: for (?:reports|replies))?|use [1-4] decimal places in tables|keep (?:it|replies|reports) (?:brief|concise)|(?:put|give) (?:the )?conclusion first)[.!]?$/iu;

export function presentationRule(text) {
  if (typeof text !== 'string' || text.length > 180) return null;
  const quote = text.trim();
  const matched = zh.exec(quote) ?? en.exec(quote);
  return matched ? { quote, standing: Boolean(matched[1]) || /^(?:我的表达偏好是|我喜欢)/u.test(quote) } : null;
}

/** Whole direct requests, including several independent presentation sentences.
 * A quoted instruction or an unclassified surrounding condition cannot lend
 * its substring account scope. */
export function presentationStatements(text) {
  // A block quotation at the start is material supplied by the author. Only
  // after a blank paragraph ends it can the person's separate request begin.
  const direct = text.replace(/^(?:>[^\n]*\n)+\n+/u, '');
  const parts = direct.match(/[^。！？!?.\n]+[。！？!?.]?/gu) ?? [];
  const rules = parts.map(presentationRule);
  if (!parts.length || parts.join('').trim() !== direct.replace(/\n/g, '').trim() || rules.some(rule => !rule)) return [];
  return rules.map(rule => rule.quote);
}
