import * as vm from "../vm.mjs";

function botForComputer(computer, bot) {
  return {
    ...(bot || {}),
    vm: {
      ...(bot?.vm || {}),
      container: computer?.container ?? bot?.vm?.container ?? null,
      volume: computer?.volume ?? bot?.vm?.volume ?? null,
    },
  };
}

export const localDockerBackend = Object.freeze({
  name: "local-docker",

  inspect(computer) {
    return vm.inspectState(computer?.container);
  },

  start(computer, bot, onLog = () => {}, shouldAbort = async () => false) {
    return vm.startVm(botForComputer(computer, bot), onLog, shouldAbort);
  },

  waitForDesktop(_computer, bot, options) {
    return vm.waitForDesktop(bot, options);
  },

  pause(computer) {
    return vm.pauseContainer(computer?.container);
  },

  resume(computer) {
    return vm.resumeContainer(computer?.container);
  },

  reboot(computer) {
    return vm.rebootContainer(computer?.container);
  },

  stop(computer) {
    return vm.stopContainer(computer?.container);
  },

  destroy(computer, bot) {
    return vm.stopVm(bot || botForComputer(computer), { wipe: true });
  },

  resetRuntime(computer, bot) {
    return vm.stopVm(bot || botForComputer(computer), { wipe: false });
  },
});
