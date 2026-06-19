/**
 * A minimal Chinese-to-Pinyin initials lookup map (~2KB).
 * To be expanded for step-42, currently handles basic mapping.
 */
export function getPinyinInitial(char: string): string {
  // A simple fallback for now.
  // In a real implementation, we would use a lookup table for common Chinese characters
  // mapping them to a-z.
  
  if (/[a-zA-Z]/.test(char)) {
    return char.toLowerCase();
  }
  
  // Basic lookup map could be placed here
  const basicMap: Record<string, string> = {
    '中': 'z', '文': 'w', '推': 't', '荐': 'j', '搜': 's', '索': 's',
    '命': 'm', '令': 'l', '会': 'h', '话': 'h', '主': 'z', '题': 't',
    '界': 'j', '面': 'm', '语': 'y', '言': 'y', '退': 't', '出': 'c',
    '清': 'q', '空': 'k', '消': 'x', '息': 'x', '权': 'q', '限': 'x',
    '模': 'm', '式': 's', '管': 'g', '理': 'l', '子': 'z', '技': 'j',
    '能': 'n', '已': 'y', '加': 'j', '载': 'z', '列': 'l', '注': 'z',
    '册': 'c', '打': 'd', '开': 'k', '交': 'j', '互': 'h', '配': 'p',
    '置': 'z', '向': 'x', '导': 'd', '花': 'h', '费': 'f', '上': 's',
    '下': 'x', '帮': 'b', '助': 'z', '浮': 'f', '层': 'c', '进': 'j',
    '入': 'r', '长': 'c', '程': 'c', '任': 'r', '务': 'w', '循': 'x',
    '环': 'h', '与': 'y', '吉': 'j', '祥': 'x', '物': 'w', '动': 'd',
    '强': 'q', '制': 'z', '创': 'c', '建': 'j', '查': 'c', '点': 'd',
    '或': 'h', '历': 'l', '史': 's', '记': 'j', '忆': 'y', '存': 'c',
    '储': 'c', '跃': 'y'
  };

  return basicMap[char] || char;
}

export function getPinyinInitials(text: string): string {
  return Array.from(text).map(getPinyinInitial).join('');
}
