/** Member authorization only; DSH owns the original Agent, subprocess, argv,
 * terminal lifecycle and sandbox policy. Revocation may still close resources. */
export function installMemberTerminals(receiver, { isMember, authorize = () => {} }) {
  const controller = receiver[Symbol.for('cordis.original')] ?? receiver, restores = [];
  for (const name of ['create', 'environment', 'shells', 'attach', 'rename', 'close']) {
    const original = controller[name], own = Object.getOwnPropertyDescriptor(controller, name);
    if (typeof original !== 'function') continue;
    controller[name] = function(agent, ...args) {
      if (isMember(agent) && name !== 'close') authorize(agent, name);
      return original.call(this, agent, ...args);
    };
    const wrapper = controller[name];
    restores.push(() => {
      if (controller[name] !== wrapper) return;
      if (own) Object.defineProperty(controller, name, own); else delete controller[name];
    });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
