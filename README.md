# Workouts

A personal workout logger for iPhone: big numbers, last time's weights and reps, and a 90-second rest timer.

It is an installable web app. It runs in Safari, you add it to your Home Screen, and after that it opens like an app and works with no signal.

## Opening it on your iPhone

The files need to be served from an `https://` address once. After that the app is stored on the phone.

1. Open the app's address in **Safari** (not Chrome, and not inside another app).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open **Workouts** from the Home Screen icon from now on, not from Safari.

Step 3 matters: the Home Screen app keeps its own storage, separate from Safari's. Workouts logged in a Safari tab won't show up in the Home Screen app.

## Trying a workout

1. **New workout type**: name it, for example "Triceps & biceps".
2. **Add exercise**, then **Create new exercise**: name it. Add a few more.
3. Go back Home. Nothing is logged yet, and no history entry is created.
4. Open the workout type and tap **Start workout**. Tap an exercise.
5. Enter weight and reps with the − and + buttons. Tapping the number lets you type instead. Then tap **Set complete**.
6. During rest, adjust reps if they were different. Tap **+ Extra reps** for reps done after a short pause. If nothing changed, tap **Looks right**.
7. Tap **Next set** or **Exercise complete**. When you're done, tap **Finish workout** to see the summary.

## How your history is saved

- Everything is stored **on your phone**, inside this app, using the browser's database (IndexedDB). Every tap is saved right away. Nothing is sent to a server.
- A second copy of the data is kept in the app's local storage. If the database ever comes back empty, the app restores from that copy.
- The app asks iOS to keep its storage permanently. Apple says Home Screen web apps are exempt from Safari's rule that clears website data after 7 days without use.
- **Risks you should know about:** deleting the Home Screen icon deletes its data. So can Settings › Safari › Clear History and Website Data, and moving to a new phone without a backup.
- **Backup:** Home › *Backup & settings* › **Export backup file** saves a `.json` file through the share sheet. Save it to iCloud Drive or Files. **Import backup file** merges a backup back in and never deletes anything. Home shows a reminder if you haven't exported in two weeks.

## Suggested vs. confirmed numbers

- The set screen is prefilled from the last **confirmed** set with the same number for that exercise ("Last time · Set 2"). If there isn't one, it uses your previous set from this workout. A brand-new exercise starts blank.
- If you change a number before tapping **Set complete**, that set is saved as **confirmed**.
- If you tap Set complete without changing the suggestion, the set is saved straight away as **pending**. Tapping **Looks right**, or changing any value during rest, confirms it.
- If you move on without doing either, the set is kept but marked **unconfirmed**. It shows as a dashed row with a "?" in summaries, and it is left out of progress comparisons.

## Progress in the summary

For each exercise, the app looks at the last workout (of any type) that has confirmed sets for that exercise. It compares set 1 with set 1, set 2 with set 2, and so on, **only when the weight matches**. Extra reps are not counted. A set that has no matching earlier set doesn't count as an improvement. A heavier top weight is reported on its own, without any claim about reps. If the data can't support a comparison, the summary says so plainly.

## Rest timer on iPhone: what works and what doesn't

- The timer counts down to a saved end time. Switching apps, locking the phone, or closing the app doesn't make it drift. When you come back, it shows the right time, or **Ready**.
- While a workout is open, the app asks iOS to keep the screen awake. This needs a recent iOS version (18.4 or later for Home Screen apps). Otherwise the phone can auto-lock as usual.
- At zero it shows **Ready** and plays one soft chime. The chime only plays if the app is on screen at that moment. **The silent switch mutes it.**
- **No vibration on iPhone**: Safari doesn't allow web apps to vibrate.
- **No alert while the app is in the background or the phone is locked.** iOS pauses web apps that aren't on screen, and a timed local notification would need a server. Keep the app open during rest. It never advances on its own.

## Updating

When the files change, the next launch downloads them in the background and the launch after that uses them. Your data isn't affected.

## Files

`index.html`, `styles.css`, `app.js` (screens), `logic.js` (suggestions and progression), `store.js` (storage), `sw.js` (offline), `manifest.webmanifest`, icons.
Tests: `node tests/logic.test.js`. For the end-to-end test, serve the folder (`python3 -m http.server 8123`) and run `node tests/e2e.mjs` (needs Playwright).
