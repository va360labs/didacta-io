# Didacta Learn — UI kit

A high-fidelity, click-thru recreation of the **Didacta Learn** student / formador platform, built directly from the brand guidelines (no codebase or Figma file was provided).

## Files

| File | What it is |
|---|---|
| `index.html` | Click-thru entry point. Loads React + Babel and mounts `<App />`. |
| `App.jsx` | Top-level shell — owns navigation state and routes between views. |
| `Sidebar.jsx` | Dark Azul-noche sidebar with brand lockup, two grouped sections, and user footer. |
| `Header.jsx` | Top bar with page title, search (`⌘K`), `Crear curso` primary CTA, message + bell icon buttons. |
| `Primitives.jsx` | `Card`, `Button` (primary / secondary / success / alert / ghost), `Badge`, `Progress`, `StatCard`. |
| `Icon.jsx` | Lucide-style line icons, 1.75 stroke weight, used everywhere. |
| `CourseCard.jsx` | The central course card pattern — cover, status pill, progress bar, CTA. Also exports `COURSES` mock data. |
| `Dashboard.jsx` | Home view — greeting, KPI stats, AI-suggestion strip, "Continúa donde lo dejaste" grid, próximas sesiones, actividad de equipo. |
| `CourseDetail.jsx` | Course hero + module list with done / current / locked states + AI assistant panel + cumplimiento card. |
| `Community.jsx` | Threads list with tag filter chips, sidebar with espacios activos and your activity. |

## Click-thru flow

1. Lands on **Inicio** (Dashboard).
2. Click any course → **CourseDetail**.
3. Sidebar `Comunidad` → **Community**.
4. Sidebar `Cursos` → grid of all courses.
5. Other sections (Rutas, Calendario, Informes, Certificados, Cumplimiento, Ajustes) show a labeled placeholder noting they're TBD.

## Design notes

- All tokens come from `../../colors_and_type.css`. No hard-coded colors that aren't already in the palette.
- Sidebar uses Azul noche `#0D1B2A`; active item uses a muted Azul equilibrio fill (`rgba(46, 125, 206, 0.18)`).
- Cards: white, 1px `#D7DEE8` border, 16px radius, `shadow-sm` at rest, `shadow-md` on hover.
- AI is presented as a **discreet** sidebar/inline strip with an `IA` micro-badge — never as a robot avatar or neon glow.
- Iconography is Lucide-style hand-rolled inline SVGs (1.75 stroke, rounded caps). If you supply an official icon set, swap `Icon.jsx`.

## Known gaps / placeholder areas

- Routes, Calendar, Reports, Certificates, Compliance, Settings show a placeholder rather than full screens. Confirm priority and we'll build them.
- Mock data is illustrative only — names, course titles, KPIs are fabricated.
- No real photography. Course covers use brand-color gradients with a discreet open-book SVG motif.
