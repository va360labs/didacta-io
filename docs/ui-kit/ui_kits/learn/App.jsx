/* eslint-disable react/no-unknown-property */

function App() {
  const [view, setView] = React.useState('home');
  const [activeCourse, setActiveCourse] = React.useState(null);

  const navTo = (id) => {
    setActiveCourse(null);
    setView(id);
  };
  const openCourse = (c) => {
    setActiveCourse(c);
    setView('courseDetail');
  };

  const titles = {
    home: 'Inicio',
    courses: 'Cursos',
    routes: 'Rutas',
    community: 'Comunidad',
    calendar: 'Calendario',
    reports: 'Informes',
    certificates: 'Certificados',
    compliance: 'Cumplimiento',
    settings: 'Ajustes',
    courseDetail: activeCourse?.title || 'Curso',
  };

  const sidebarActive = view === 'courseDetail' ? 'courses' : view;

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: '#F8FAFC',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <Sidebar active={sidebarActive} onNavigate={navTo} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header title={titles[view]} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {view === 'home' && <Dashboard onOpenCourse={openCourse} />}
          {view === 'courseDetail' && (
            <CourseDetail course={activeCourse} onBack={() => navTo('courses')} />
          )}
          {view === 'community' && <Community />}
          {view === 'courses' && (
            <div style={{ padding: '28px 32px', maxWidth: 1280, margin: '0 auto' }}>
              <h1
                style={{
                  fontFamily: 'Sora',
                  fontWeight: 800,
                  fontSize: 32,
                  color: '#0D1B2A',
                  margin: '0 0 24px',
                  letterSpacing: '-0.02em',
                }}
              >
                Tus cursos
              </h1>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
                {COURSES.map((c) => (
                  <CourseCard key={c.id} course={c} onOpen={openCourse} />
                ))}
              </div>
            </div>
          )}
          {!['home', 'courseDetail', 'community', 'courses'].includes(view) && (
            <div style={{ padding: 80, maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 18,
                  background: '#E8F1FB',
                  color: '#1E5AA8',
                  display: 'grid',
                  placeItems: 'center',
                  margin: '0 auto 20px',
                }}
              >
                <Icon
                  name={
                    view === 'routes'
                      ? 'route'
                      : view === 'calendar'
                        ? 'calendar'
                        : view === 'reports'
                          ? 'chart'
                          : view === 'certificates'
                            ? 'award'
                            : view === 'compliance'
                              ? 'shield'
                              : 'settings'
                  }
                  size={32}
                />
              </div>
              <h2
                style={{
                  fontFamily: 'Sora',
                  fontWeight: 700,
                  fontSize: 26,
                  color: '#0D1B2A',
                  margin: '0 0 8px',
                }}
              >
                {titles[view]}
              </h2>
              <p
                style={{
                  fontFamily: 'Inter',
                  fontSize: 16,
                  color: '#475569',
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                Esta sección forma parte del UI kit de Didacta Learn. Vista previa pendiente de
                definir junto al equipo.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.App = App;
