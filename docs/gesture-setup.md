# Gestures setup wizard (naru task 1975)

Settings > Gestures (Mac app only). Opens on the first turn-on of "Gestures on" while the host reports setup not done, and from "Run setup again". Four steps: Camera (camera required, Accessibility optional), Calibrate (live checks), Safety, First binding.

Logic is `frontend/src/gestureWizard.ts` (tested); UI is `components/GestureSetupWizard.tsx`; wiring is in `GesturesSection.tsx`.

## Host contract (extra calls on `window.naruGestures`)

`setupBridge()` uses these when the host offers all of them. Otherwise, inside the Mac app (the `naruLive` handler exists), `gestureSetupHost.ts` builds them over the transport naru-mac already speaks: `{type:"permissions", id, op}` answered by `naruNativeHost.permissionsReply`/`permissionsChanged`, and `{type:"calibration", op:start|stop}` streaming `calibrationSample`. The safety defaults and the done flag are then kept in the page's localStorage (`naru-gesture-setup`), not in the native store (naru-mac has no field for them yet). In a plain browser no wizard shows.

- `loadSetup() -> {done, safety|null}` / `saveSetup({done, safety})` — persisted by the host, or localStorage as above. `safety` = `{armBeforeFiring, holdS (0.8), cooldownS (2), confirmRisky, pauseOnCall, killSwitch}`.
- `permissions()`, `requestCamera()`, `requestAccessibility()` -> `{camera, accessibility}` each `granted|denied|notDetermined`; `openSettings('camera'|'accessibility')`; `onPermissionsChanged(cb)`.
- `calibrate(cb)` streams `{handDetected, lighting: ok|dark|bright|unknown, distance: ok|tooClose|tooFar|none, fps, fpsOk}`; its stop function releases the camera. The wizard calls it only while step 2 shows.
- `onSeen` events may carry `score` (0..1); the try-it strip shows it, else the hold progress.

Skipping Accessibility or the camera never blocks finishing. Finish, Add another and Start empty all save `done: true`.
