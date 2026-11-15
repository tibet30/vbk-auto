/**
 * 测试用 .less loader：把 CSS Modules 导入替换成"类名即键名"的代理。
 *
 * 组件测试只需要断言 DOM 结构与文案，不校验样式值；没有这层处理时
 * `import styles from "./x.module.less"` 在 node:test 下无法解析。
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".less")) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_target, key) => typeof key === 'string' ? key : undefined });",
    };
  }
  return nextLoad(url, context);
}
