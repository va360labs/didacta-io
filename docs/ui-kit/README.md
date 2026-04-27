# Didacta — Design System

> Plataforma educativa modular, abierta y preparada para escalar.

Didacta is a modular, open, and scalable education platform — designed to feel professional, trustworthy, accessible, and human across schools, businesses, public administrations, academies, consultancies, and internal training programs. Although AI is part of the product, the visual identity intentionally avoids futuristic / cyberpunk tropes. The brand reads as **serious, open, modular**, and **community-oriented**.

The brand promise:
> *Tecnología educativa seria, abierta y preparada para crecer contigo.*

---

## Sources used to build this system

- **Brand guidelines** — full identity guide pasted into the design brief (sections 1–28). This drives every token in `colors_and_type.css`.
- **Logo assets** — provided by the user as PNG uploads:
  - `uploads/logo.png` → `assets/logo.png` (full lockup, dark, with descriptor)
  - `uploads/logo-blanco.png` → `assets/logo-blanco.png` (light/inverted lockup for dark surfaces)
  - `uploads/anagrama.png` → `assets/anagrama.png` (square app-icon style isotype on Azul noche)
- No codebase, Figma file, or sample slide deck was provided. UI kits below are recreated from the written guidelines, not from an existing implementation.

---

## Index — what's in this folder

| File / Folder | What it is |
|---|---|
| `README.md` | This file — manifest, content + visual foundations, iconography. |
| `SKILL.md` | Cross-compatible Agent Skill front matter so this system can be used inside Claude Code. |
| `colors_and_type.css` | All design tokens: colors, semantic colors, typography scale, radii, spacing, shadows. Single source of truth. |
| `assets/` | Brand assets — logos (`logo.png`, `logo-blanco.png`, `anagrama.png`). |
| `preview/` | HTML cards rendered in the Design System tab — one card per concept (color group, type specimen, button, component cluster). |
| `ui_kits/learn/` | UI kit recreating the **Didacta Learn** student platform — sidebar, dashboard, course cards, lesson reader, community, certificates. |

---

## Content fundamentals

The voice of Didacta is **clear, direct, and human** — Spanish-first. It addresses the reader informally (`tu`/`tu equipo`) but with the calm authority of a mature institutional product. It avoids tech jargon, never reads as cold or robotic.

**Tone**
- Calm, helpful, never urgent or salesy.
- Action-oriented: most microcopy is an instruction or a status update, not a description.
- AI is referenced *only when it adds value* and labeled discreetly (e.g. `Sugerido por Didacta`). Never shouted.

**Casing**
- Sentence case for buttons, menu items, card titles, dialog headers. (`Crear curso`, not `Crear Curso`.)
- Title case is reserved for proper nouns and module names (`Didacta Learn`, `Didacta Studio`).
- Uppercase only for tiny captions / badges (`PENDIENTE`, `NUEVO`).

**Person**
- `tú` to the user — never `usted`, never `vosotros`.
- The product refers to itself as *Didacta* (third person) when it acts: `Didacta ha preparado una sugerencia…`.
- For team / org contexts: `tu equipo`, `tu organización`.

**Microcopy examples (taken from the guidelines)**
- ✅ `Continúa donde lo dejaste`
- ✅ `Tu progreso esta semana`
- ✅ `Tienes 3 actividades pendientes`
- ✅ `Este curso ya está listo para publicar`
- ✅ `Revisa la configuración antes de activar la ruta`
- ✅ `Didacta ha preparado una sugerencia para mejorar este módulo`
- ✅ `Invita a tu equipo` · `Crea una nueva ruta de aprendizaje` · `Publicar para alumnos` · `Guardar como borrador`
- ❌ Avoid: `Ejecutar operación`, `Procesando entidad`, `Objeto no válido`, `Error desconocido`.

**Emoji**
- Not part of the brand voice. Don't use emoji in product copy, marketing, certificates, or community defaults. Community user content can include emoji, but UI chrome never does.

**Errors**
- State the problem in plain language, then how to fix it. `No hemos podido guardar los cambios. Revisa tu conexión y vuelve a intentarlo.` — never `Error 500`.

**Vibe**
- It feels like a calm guide on your desk: serious enough to trust with compliance and ROI conversations, warm enough to invite a teacher in. Closer to a well-run university platform than a startup SaaS.

---

## Visual foundations

### Color
The palette is **70% white + light surfaces, 20% deep / trust blue, 8% growth teal, 2% coral**. This proportion is non-negotiable — it is what keeps the platform reading as professional rather than playful.

- **Azul noche `#0D1B2A`** — institutional surfaces (sidebar, footers, high-jerarquía text, premium / compliance areas).
- **Azul confianza `#1E5AA8`** — primary action color (buttons, links, active tabs, selected states).
- **Azul equilibrio `#2E7DCE`** — secondary / informational (graphs, info messages, illustrations).
- **Verde crecimiento `#18B5A8`** — progress, success, completion, learning checkpoints.
- **Coral energía `#FF6F61`** — controlled accent. Soft alerts, attention badges, promo highlights. Never primary.
- **Gris claro `#F1F3F5` / Blanco** — base canvas. Most surfaces.

### Typography
- **Sora** for display (H1–H3, big metrics, marketing headlines). Geometric, modern, sólido.
- **Inter** for body, UI, tables, forms, microcopy. Neutral, optimized for dense interfaces.
- Display weights stay at 700/800 for headlines but never bleed into UI chrome — interfaces use Inter Regular/Medium/SemiBold.

### Spacing & layout
- 4px base scale (`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64`).
- Generous whitespace; cards breathe; never edge-to-edge dense.
- Layout is **sidebar + header + main + optional context panel**. Cards are the central building block.

### Backgrounds & imagery
- Surfaces are **flat white or `#F1F3F5`**. No gradients on UI chrome.
- Marketing surfaces may use **soft, low-contrast curves** derived from the open-book motif of the logo — never bright neon gradients.
- Imagery is **warm, human, photographic** when used (real classrooms, real people). Avoid stock 3D renders, neon, abstract circuits.
- Empty states / onboarding may use the brand's curve / book / module shapes as quiet illustration — discreet, not decorative.

### Animation & motion
- Subtle, functional fades and slides only. Easing leans toward `cubic-bezier(0.2, 0, 0, 1)` (calm ease-out).
- Durations short: 150–250ms for micro, 300–400ms for panel transitions.
- No bounces, no spring physics, no parallax. Never animate brand elements decoratively.

### States
- **Hover** on buttons → 6–8% darker (multiply with `#0D1B2A` overlay), or `#F1F3F5` fill on ghost / secondary buttons.
- **Active / press** → no shrink. Slight darken plus reduced shadow. The product feels stable, not bouncy.
- **Focus** → visible 3px ring `rgba(30, 90, 168, 0.25)` outside the element, never just color change.
- **Disabled** → bg `#F1F3F5`, fg `#94A3B8`, border `#E2E8F0`, no shadow.

### Borders, radii, shadows
- Default radius **`12px`** (cards, panels). Buttons / inputs **`8–10px`**. Pills `999px` for badges & tags.
- Borders `1px solid #D7DEE8` on cards & inputs. Borders are visible but never heavy.
- Shadow system is **deliberately subtle**:
  - `xs / sm` for cards at rest.
  - `md` on hover / popovers.
  - `lg` only for modals, command-k, and the AI side-panel.
- No inner shadows. No colored shadows. No glows.

### Transparency, blur, gradients
- Used sparingly. Sidebar may use a subtle radial wash on Azul noche. Marketing portadas can use 5–10% white overlay on photography for legibility.
- No glassmorphism in product chrome.
- No CSS gradients on buttons.

### Card anatomy
Cards are the central building block.
- White background, 1px `#D7DEE8` border, radius **12–20px**, shadow `xs`/`sm`.
- Internal padding **`24px`**. Title (Sora SemiBold or Inter SemiBold), supporting metadata in `--didacta-ink-400`, then content, then a clear CTA.
- Hover: shadow → `md`, border darkens slightly. No transform / scale.
- Progress bars sit at 6–8px height, radius pill, fill in `--didacta-growth`.

---

## Iconography

Didacta's iconography is **lineal, clear, with consistent stroke weight, and slightly rounded corners**. The guidelines explicitly forbid futuristic / cyberpunk imagery, brains, neon circuits, robots.

- **Style**: line icons, **1.5px – 2px** stroke, rounded line caps and joins, minimal detail, easy to recognize at 16–24px.
- **Color**: primary use in `--didacta-night`. Active states in `--didacta-trust`. Progress / success in `--didacta-growth`. Informational in `--didacta-balance`. Coral only for warnings and attention badges.
- **No icon font / SVG sprite was provided** with the brief. We adopt **Lucide** (https://lucide.dev) as the working icon set — its 1.5–2px rounded-cap strokes match the guideline almost exactly. Loaded via CDN: `https://unpkg.com/lucide@latest`. **Flagged for the user**: confirm Lucide as the official icon library, or swap for a custom set.
- Key icons used across the system map to the brief's list: `book-open` (libro), `graduation-cap` (curso), `user`, `users` (comunidad), `calendar`, `award` (certificado), `trending-up` (progreso), `layers` (módulo), `clipboard-check` (evaluación), `shield-check` (seguridad), `sparkles` (IA — discreet), `settings`, `message-circle` (mensajes), `bar-chart-3` (informes).
- **Emoji**: not used in product or marketing chrome.
- **Unicode glyphs**: used very sparingly for arrows and chevrons (›, →) where Lucide would feel heavy. Never as a full icon system.

---

## Asks for the user (please review)

- **Fonts** — we're loading Sora and Inter from Google Fonts. Both are open, official Google Fonts and match the brief exactly. If you have Didacta-licensed font files (e.g. for offline / brand assets), share them and we'll swap.
- **Icon set** — we substituted **Lucide** since no icon set was provided. Confirm or supply a custom set.
- **Imagery** — no photography or illustrations were uploaded. UI mocks use neutral placeholders. Share a few real classroom / learner photos if you'd like the kit to reflect them.
- **Codebase / Figma** — none was attached. The UI kit is built from the written guidelines, not an existing implementation. If a Figma or repo exists, link it and we'll align the kit to the real product.
