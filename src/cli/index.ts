// Setup must work before opening/migrating the persistent store, even with a broken native binding.
if (process.argv[2] === "setup") {
  const { Command } = await import("commander");
  const { setupCommand } = await import("./setup.js");
  await new Command("crane").addCommand(setupCommand()).parseAsync(process.argv);
} else {
  const { Store } = await import("../core/store.js");
  const { runCli } = await import("./program.js");
  await runCli(process.argv, new Store());
}
