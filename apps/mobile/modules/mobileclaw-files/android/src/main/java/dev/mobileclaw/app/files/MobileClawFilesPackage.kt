package dev.mobileclaw.app.files

import expo.modules.core.interfaces.Package

/**
 * Registers this local module with the Expo module system.
 *
 * The module class itself is named in `expo-module.config.json`; this class exists because
 * the generated `ExpoModulesPackageList` instantiates every package
 * (`GeneratePackagesListTask.kt` emits `${it}()`), so it must have a no-argument
 * constructor. `Package` is an interface of default methods, hence the empty body.
 */
class MobileClawFilesPackage : Package
