# Didacta Design Skill

---
name: didacta-design
description: Use this skill to generate well-branded interfaces and assets for Didacta, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files (`colors_and_type.css`, `assets/`, `preview/`, `ui_kits/learn/`).

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. Always import `colors_and_type.css` and use the CSS variables it defines — never hard-code Didacta colors. Reuse the JSX components in `ui_kits/learn/` as starting points; they cover Sidebar, Header, Card, Button, Badge, Progress, StatCard, CourseCard, Dashboard, CourseDetail and Community.

If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions (audience, surface, fidelity, variations), and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Brand quick reference

- **Voice**: Spanish-first, calm, direct, human. `tú`, never `usted`. No emoji in chrome.
- **Colors**: 70% white/grey · 20% Azul noche `#0D1B2A` + Azul confianza `#1E5AA8` · 8% Verde crecimiento `#18B5A8` · 2% Coral `#FF6F61`.
- **Type**: Sora (display, 700/800) + Inter (UI, 400/500/600).
- **Vibe**: serious, modular, open. Avoid neon, robots, futuristic / cyberpunk, infantile illustration.
- **Cards** are the central building block. 12–16 px radius, 1px `#D7DEE8` border, subtle shadow.
- **AI** is a discreet helper — `Sugerido por Didacta` micro-badge, never the dominant visual.
