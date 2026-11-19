export const name = 'hello-dsh';
export const inject = ['commands'];

export function apply(ctx, config) {
  ctx.commands.register({
    name: 'hello_dsh',
    description: '向指定名字问好',
    input: { hint: '[名字]' },
    handler({ rawInput }) {
      const who = rawInput.trim() || '世界';
      return { kind: 'success', text: `${config.greeting || '你好'}，${who}！` };
    },
  });
}
