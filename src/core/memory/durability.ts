// Extraction prompts handle meaning. These checks catch common snapshots even
// when a provider labels them as confirmed preferences or project decisions.
const SNAPSHOT_PATTERNS = [
  // A reported value, as opposed to a rule such as "check the current branch".
  /(?:^|[.;!?:,\n]\s*|[-*] )(?:(?:the|our|my|its|your|the project’s|the project's)\s+)?(?:current|active|latest|installed)\s+(?:git\s+)?(?:branch|commit|version|port|status|price|balance|location|model|ip(?: address)?)(?: of [\w.-]+)?\s*(?:is\b|[:=])/i,
  /(?:^|[。；，：\n]\s*|[-*] )(?:(?:项目|用户|仓库)(?:的)?)?(?:当前|目前|现用|最新|已安装)(?:的)?(?:所在)?\s*(?:Git\s*)?(?:分支|提交号|版本号?|端口号?|状态|价格|余额|位置|模型|IP地址)\s*(?:是|为|在|[:：=]|[\dv])/i,
  /\b(?:currently|right now)\s+(?:on (?:the )?branch|(?:running|listening) on (?:port )?\d|(?:using|uses|running) [\w.-]+\s+v?\d+\b)/i,
  /(?:目前|当前|现在|暂时)(?:正在)?(?:使用|运行|监听|位于|处于|切到|在)\s*.{0,24}(?:分支|端口|[A-Za-z][\w.-]*\s+v?\d+\b|v?\d+\.\d+)/i,
  /\b(?:is (?:running|listening) on port|checked out on branch)\s+\S+/i,
  /(?:正在监听(?:端口)?|正在运行在端口)\s*[:：]?\s*\d+/,

  // Explicitly limited choices can otherwise look just like standing preferences.
  /\b(?:for (?:now|the time being)|(?:only )?for this (?:session|task|run)|(?:this (?:session|task|run)|today) only)\b/i,
  /(?:仅限|仅在|只在|只针对|仅针对)(?:今天|本次|这次|当前会话)|(?:这次|本次)(?:任务|会话)?(?:先|临时|暂时|使用|用|改用)|(?:暂时|临时)(?:使用|改用|切换到|设为|用)/,

  // Results of a single run. Keep instructions such as "all tests must pass".
  /\b\d+\s+(?:tests?|checks?)\s+(?:passed|failed|passing|failing)\b/i,
  /(?:测试|检查)(?:结果)?\s*[:：]?\s*\d+\s*(?:个|项)?(?:通过|失败)|\d+\s*(?:个|项)(?:测试|检查)(?:已)?(?:通过|失败)/,
  /(?:进度|完成度)\s*(?:已达|达到|是|为|[:：])?\s*\d+(?:\.\d+)?\s*%|\b(?:progress\s*(?:is|at|[:=])\s*\d+%|\d+%\s+(?:done|complete)\b)/i,
];

export function isVolatileMemory(text: string): boolean {
  return SNAPSHOT_PATTERNS.some((pattern) => pattern.test(text));
}
