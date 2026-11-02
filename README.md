# UDX Loader

An animated loading screen for UDX, built with React, TypeScript and Vite. It has no runtime dependencies beyond React.

1. It types `UDX✝` with an orange cursor.
2. The cursor strikes right-to-left through the cross, which shatters into small cross fragments. They burst up over the X and D, rising just above the logo, are seen through its gaps, and fade out before they would drift beyond it.
3. The UDX logo is revealed in the cursor's wake, emerging from depth as it slides in from the right. Two small crosses drop into the U and fade away.
4. The logo glows once from its bottom contour (the U's point and the rising diagonal towards the X) with a soft orange-red emission and gentle bloom, while the upper U, D and X stay solid black; then it settles back to solid black.

The whole sequence takes about 3.44 s, on a clean white background. It adapts to any screen size and respects `prefers-reduced-motion`.

## Getting started

Requires Node.js 18, 20 or 22+.

```bash
npm install
npm run dev
```

The dev server opens http://localhost:5173 and plays the animation once.

| Script | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build for production into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | Run ESLint |

## Project structure

```
src/
  App.tsx                      demo page: the loader, full screen
  main.tsx                     React entry point
  index.css                    page styles
  components/UdxLoader/
    UdxLoader.tsx              the component
    UdxLoader.module.css       its styles (CSS Modules)
    timeline.ts                timing, motion and effect parameters
    udxLogo.ts                 the UDX logo (transparent PNG, 3×), embedded
    udxLoaderFont.ts           embedded subset of JetBrains Mono (with the ✝ glyph)
    index.ts                   public exports
    README.md                  props, timeline and implementation notes
```

## Use it in your app

Copy `src/components/UdxLoader/` into your project, then:

```tsx
import { UdxLoader } from './components/UdxLoader';

{loading && <UdxLoader fullscreen onComplete={() => setLoading(false)} />}
```

It works in Vite, Create React App and Next.js (it starts with `'use client'`). Without `fullscreen`, it fills its parent, so give the parent a height.

Props such as `background`, `accentColor`, `logoSrc` and `onComplete`, and the timeline, are documented in [src/components/UdxLoader/README.md](src/components/UdxLoader/README.md).

## Credits

The text uses a subset of [JetBrains Mono](https://www.jetbrains.com/lp/mono/), licensed under the SIL Open Font License 1.1. The notice is included in `udxLoaderFont.ts`.
