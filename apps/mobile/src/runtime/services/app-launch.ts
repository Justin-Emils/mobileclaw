/**
 * Bringing an installed app to the front, through Android's own resolver.
 *
 * ## The defect this exists to prevent
 *
 * The first version of this call looked package-pinned and was not:
 *
 *   IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
 *     packageName: packageId,                      // silently ignored
 *     category: "android.intent.category.LAUNCHER",
 *   })
 *
 * In Expo's native `IntentLauncherModule` (android/src/main/java/expo/modules/intentlauncher/
 * IntentLauncherModule.kt) `params.packageName` is read **only inside** `params.className?.let`:
 *
 *   params.className?.let {
 *     intent.component = ComponentName(params.packageName, params.className)
 *   }
 *   ...
 *   params.category?.let { intent.addCategory(it) }
 *
 * With no `className` the package name never reaches the intent, so what went out was an
 * unbound `ACTION_MAIN` + `CATEGORY_LAUNCHER` intent. Android resolves that against *every*
 * app advertising a launcher: the agent could land in an unrelated app, and because a
 * disambiguation choice is remembered, a single 「总是」 pinned the wrong app for every later
 * launch. Reproduced on an emulator: `am start -a ... MAIN -c ... LAUNCHER` with no `-p`
 * opens the resolver, while the package-filtered form resolves to exactly one activity.
 *
 * `getLaunchIntentForPackage` asks Android which activity actually launches this package, and
 * throws `PackageNotFoundException` when there is none. A failure is therefore reported rather
 * than silently becoming a different app.
 *
 * ## Why the launcher is injected
 *
 * `openApplication` is a plain native `Function`, not an `AsyncFunction`: it returns void and
 * reports failure by throwing **synchronously**. That is easy to get wrong (an `await` on it
 * catches nothing), so it is wrapped and unit-tested with a fake launcher rather than only
 * being exercised on a device.
 */

/** The slice of `expo-intent-launcher` this module uses. */
export interface AppLauncher {
  openApplication(packageName: string): void;
}

/**
 * Launch `packageId`, or throw an error that says why it could not be launched.
 *
 * The message is Chinese because it reaches the user through the tool card. The original
 * failure gave a bare 失败 with no cause and no next step, which is what made this look like a
 * mystery rather than "this app has no launcher entry".
 */
export async function openAppByPackageId(
  packageId: string,
  launcher: AppLauncher,
): Promise<void> {
  const id = packageId.trim();
  if (!id) {
    throw new Error("打不开应用：没有给出包名。先用 system_apps 查一下包名。");
  }

  try {
    // Deliberately not awaited: see the note above. Keeping the call bare inside a try is
    // what turns a synchronous native throw into a rejected promise.
    launcher.openApplication(id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `打不开「${id}」。两种常见原因：` +
        `一是该应用没有可启动的入口——纯服务型应用、以及只在被特定 Intent 唤起时才出现的组件，` +
        `都不会出现在启动器里，这类应用要用 system_open 的 url 参数走深链；` +
        `二是包名不对或应用已卸载，先用 system_apps 确认它在已安装列表中。` +
        `系统原话：${detail}`,
    );
  }
}
