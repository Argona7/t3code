# Build and update the Argona7 fork

Use a checkout of [Argona7/t3code](https://github.com/Argona7/t3code). Keep the commit hash with each build so you can reproduce it later.

## macOS

Install [Vite+](https://viteplus.dev/guide/), Xcode Command Line Tools and Rust. Run these commands from the repository root. Set `version` to the upstream release this checkout is based on.

```sh
version=0.1.10
vp i
vp run dist:desktop:dmg:arm64 --build-version "$version" --output-dir "release/$(git rev-parse --short HEAD)"
```

Use `dist:desktop:dmg:x64` on an Intel Mac. This produces a local DMG without Apple notarization. Open it and copy **T3 Code (Beta)** to Applications after the backup below. The fork uses the same T3 home as the original app, usually `~/.t3`. If you already use `T3CODE_HOME`, keep that setting. Projects, threads and environment state are under `userdata` in that directory.

## Phone and browser

If the fork's desktop app hosts your threads, keep it running and enable **Tailscale HTTPS** under **Settings → Sharing & access**. Generate a pairing link for that address and open it in your phone's browser. Both devices need access to the same tailnet. The host serves the fork's web interface at its own address. For LAN use, enable **Network access** and pair with the host's LAN address. See [Remote access](../user/remote-access.md) for setup.

To run the fork without the desktop app, build the server and bundled web client from the same commit. Stop the old host first, then reuse its T3 home and normal working directory on the same machine. This example uses Tailscale HTTPS.

```sh
version=0.1.10
vp i
APP_VERSION="$version" vp run --filter t3 build
vp exec -- node apps/server/dist/bin.mjs serve --base-dir "${T3CODE_HOME:-$HOME/.t3}" --tailscale-serve
```

Open the printed **Pairing URL** in the phone's browser. Use `--lan` in place of `--tailscale-serve` for direct pairing on a trusted local network. For another fresh pairing link, run the same bundled CLI with `pair --base-dir "${T3CODE_HOME:-$HOME/.t3}" --tailscale` on the host, or omit `--tailscale` on LAN.

## Update and roll back

1. When upstream publishes a release, merge its tag into a branch based on your fork. Add the upstream remote once with `git remote add upstream https://github.com/pingdotgg/t3code.git`. Fetch the chosen tag with `git fetch upstream tag vX.Y.Z`, then run `git merge vX.Y.Z`. Replace `X.Y.Z` with that release's version. Keep the fork's folder schema outside upstream's numbered migrations.
2. Build from the merged fork commit using that version. Keep the previous DMG, installed app or server checkout. Before switching, stop the running T3 host and copy its `userdata` directory to a separate backup. To verify migrations on a copy, place the copied `userdata` under a separate T3 home and point `--base-dir` at that home when starting the bundled server.
3. Start the new desktop app or bundled server against the same T3 home. Check that existing threads and folders open, then reconnect your phone. Only one server can use that T3 home at a time.
4. To roll back, stop the new build, move the current `userdata` aside, and restore the pre-update copy before starting the previous build. That keeps both the old database and the newer data available if the new build applied a migration.

Local desktop builds use manual updates by default. The packager ignores a GitHub update feed that points to `pingdotgg/t3code`. If you later publish your own compatible Electron releases, you can set `T3CODE_DESKTOP_UPDATE_REPOSITORY=Argona7/t3code` when building. Use the fork's DMG or bundled server for upgrades. Homebrew's `t3-code` cask and the upstream `t3 update` command install upstream builds.
