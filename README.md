# 2048
A small clone of [1024](https://play.google.com/store/apps/details?id=com.veewo.a1024), based on [Saming's 2048](http://saming.fr/p/2048/) (also a clone). 2048 was indirectly inspired by [Threes](https://asherv.com/threes/).

Made just for fun. [Play it here!](http://gabrielecirulli.github.io/2048/)

The official app can also be found on the [Play Store](https://play.google.com/store/apps/details?id=com.gabrielecirulli.app2048) and [App Store!](https://itunes.apple.com/us/app/2048-by-gabriele-cirulli/id868076805)

### Contributions

[Anna Harren](https://github.com/iirelu/) and [sigod](https://github.com/sigod) are maintainers for this repository.

Other notable contributors:

 - [TimPetricola](https://github.com/TimPetricola) added best score storage
 - [chrisprice](https://github.com/chrisprice) added custom code for swipe handling on mobile
 - [marcingajda](https://github.com/marcingajda) made swipes work on Windows Phone
 - [mgarciaisaia](https://github.com/mgarciaisaia) added support for Android 2.3

Many thanks to [rayhaanj](https://github.com/rayhaanj), [Mechazawa](https://github.com/Mechazawa), [grant](https://github.com/grant), [remram44](https://github.com/remram44) and [ghoullier](https://github.com/ghoullier) for the many other good contributions.

### Screenshot

<p align="center">
  <img src="https://cloud.githubusercontent.com/assets/1175750/8614312/280e5dc2-26f1-11e5-9f1f-5891c3ca8b26.png" alt="Screenshot"/>
</p>

That screenshot is fake, by the way. I never reached 2048 :smile:

## Building and running

Development and release builds run on npm. The pinned runtime is Node.js `24.19.0` — `.nvmrc` carries that version so `nvm use` selects it, and `package.json` requires Node `>=24.19.0` with npm `>=11.0.0`.

Install the dependencies once with `npm install`, then:

 - `npm run dev` — start the development server; it prints the local URL to open. The diagnostics overlay, health report and metrics snapshot are exercised here.
 - `npm run build` — write the production bundle to `dist/`
 - `npm run preview` — serve the built `dist/` locally, the way a static host would
 - `npm run typecheck` — type-check the sources
 - `npm test` — run the unit suite
 - `npm run test:snapshot` — run the seeded snapshot suite, a separate regression gate
 - `npm run test:e2e` — run the browser suite, which records the gameplay video; `npm run e2e:install` fetches the browser it needs the first time

### Deploying

One install and one build command — `npm install`, then `npm run build` — is the entire path from a clean machine to a deployable folder. The build emits a fully static bundle into `dist/`: HTML, CSS and JavaScript, plus the font and image assets they reference.

Deployment is copying `dist/` to any static host — GitHub Pages, Netlify, S3, or a directory on a machine that serves files. There is no server, no server-side rendering, no API routes and no serverless functions, and nothing in `dist/` needs a Node process at runtime.

### Opening the game locally

The game used to run straight from the filesystem, by opening `index.html` over `file://` with no preprocessing. It no longer does: the page loads a single ES module, and a module graph needs a served origin. Use `npm run dev` while developing, or `npm run preview` for the built output.

### Further documentation

 - [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) — Figure 1, *As-Is Architecture*, and Figure 2, *To-Be Architecture*; the component interaction, data flow and hook dispatch figures are in [`docs/architecture/component-interaction.md`](docs/architecture/component-interaction.md), [`docs/architecture/data-flow.md`](docs/architecture/data-flow.md) and [`docs/architecture/hook-dispatch-sequence.md`](docs/architecture/hook-dispatch-sequence.md)
 - [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — the logging, tracing, metrics and health surfaces, and how to exercise each one against `npm run dev`
 - [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) — the decisions behind the toolchain and the architecture, with their alternatives and risks; rationale lives there and nowhere else

## Contributing
Changes and improvements are more than welcome! Feel free to fork and open a pull request. Please make your changes in a specific branch and request to pull into `master`! If you can, please make sure the game fully works before sending the PR, as that will help speed up the process.

You can find the same information in the [contributing guide.](https://github.com/gabrielecirulli/2048/blob/master/CONTRIBUTING.md) See [`CONTRIBUTING.md`](CONTRIBUTING.md) in this repository for the house rules, including the current build and style workflow.

## License
2048 is licensed under the [MIT license.](https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt)

## Donations
I made this in my spare time, and it's hosted on GitHub (which means I don't have any hosting costs), but if you enjoyed the game and feel like buying me coffee, you can donate at my BTC address: `1Ec6onfsQmoP9kkL3zkpB6c5sA4PVcXU2i`. Thank you very much!
