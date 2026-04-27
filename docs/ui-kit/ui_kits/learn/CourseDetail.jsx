/* eslint-disable react/no-unknown-property */

function CourseDetail({ course, onBack }) {
  const c = course || COURSES[0];
  const modules = [
    { i: 1, title: 'Fundamentos del liderazgo', dur: '32 min', state: 'done' },
    { i: 2, title: 'Estilos y autoconciencia', dur: '28 min', state: 'done' },
    { i: 3, title: 'Comunicación con propósito', dur: '45 min', state: 'done' },
    { i: 4, title: 'Liderar equipos distribuidos', dur: '52 min', state: 'current' },
    { i: 5, title: 'Toma de decisiones y sesgo', dur: '38 min', state: 'todo' },
    { i: 6, title: 'Feedback transformador', dur: '42 min', state: 'todo' },
    { i: 7, title: 'Casos prácticos · empresa real', dur: '58 min', state: 'todo' },
    { i: 8, title: 'Evaluación final y rúbrica', dur: '20 min', state: 'todo', locked: true },
  ];

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          color: '#64748B',
          marginBottom: 16,
          cursor: 'pointer',
        }}
        onClick={onBack}
      >
        <Icon name="chevron-r" size={14} className="rot" />
        <span style={{ transform: 'rotate(180deg)', display: 'inline-block' }}>
          <Icon name="chevron-r" size={14} />
        </span>
        <span style={{ marginLeft: 4 }}>Cursos · {c.cat}</span>
      </div>

      {/* Hero */}
      <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr' }}>
          <div style={{ padding: '32px 36px' }}>
            <Badge tone="info" style={{ marginBottom: 14 }}>
              {c.cat} · {c.level}
            </Badge>
            <h1
              style={{
                fontFamily: 'Sora',
                fontWeight: 800,
                fontSize: 34,
                color: '#0D1B2A',
                margin: '0 0 12px',
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {c.title}
            </h1>
            <p
              style={{
                fontFamily: 'Inter',
                fontSize: 16,
                color: '#475569',
                lineHeight: 1.5,
                marginBottom: 20,
              }}
            >
              Una ruta práctica para responsables de equipo que necesitan combinar visión
              estratégica, comunicación clara y decisiones consistentes en entornos cambiantes.
            </p>
            <div
              style={{ display: 'flex', gap: 28, marginBottom: 24, fontSize: 13, color: '#475569' }}
            >
              <div>
                <b style={{ color: '#0D1B2A', fontFamily: 'Sora' }}>{c.modules}</b> módulos
              </div>
              <div>
                <b style={{ color: '#0D1B2A', fontFamily: 'Sora' }}>{c.hours}h</b> de contenido
              </div>
              <div>
                <b style={{ color: '#0D1B2A', fontFamily: 'Sora' }}>1.420</b> alumnos
              </div>
              <div style={{ color: '#0F8077' }}>
                <b>4.8</b> ★ valoración
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="primary" icon="play">
                Continuar módulo 4
              </Button>
              <Button variant="secondary" icon="award">
                Vista del certificado
              </Button>
            </div>
          </div>
          <div
            style={{
              background: c.cover,
              position: 'relative',
              minHeight: 260,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              padding: 24,
            }}
          >
            <svg
              style={{ position: 'absolute', inset: 0, opacity: 0.25 }}
              viewBox="0 0 200 200"
              preserveAspectRatio="none"
            >
              <path d="M0 140 Q100 90 200 140 L200 200 L0 200 Z" fill="rgba(255,255,255,.18)" />
              <path
                d="M0 160 Q100 110 200 160"
                stroke="rgba(255,255,255,.4)"
                strokeWidth="1.5"
                fill="none"
              />
              <path
                d="M0 180 Q100 130 200 180"
                stroke="rgba(255,255,255,.3)"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
            <div
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                color: '#fff',
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,.92)',
                  color: '#1E5AA8',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <Icon name="play" size={26} />
              </div>
              <div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>Vista previa</div>
                <div style={{ fontFamily: 'Sora', fontWeight: 600, fontSize: 16 }}>
                  2 min · introducción
                </div>
              </div>
            </div>
          </div>
        </div>
        <div
          style={{ padding: '20px 36px', borderTop: '1px solid #E2E8F0', background: '#F8FAFC' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0D1B2A' }}>Tu progreso</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0F8077' }}>
              {c.progress}% · 3 de 8 módulos
            </span>
          </div>
          <Progress value={c.progress} />
        </div>
      </Card>

      {/* Modules */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        <Card>
          <h3
            style={{
              fontFamily: 'Sora',
              fontWeight: 600,
              fontSize: 18,
              color: '#0D1B2A',
              margin: '0 0 16px',
            }}
          >
            Módulos
          </h3>
          {modules.map((m, i) => {
            const done = m.state === 'done';
            const current = m.state === 'current';
            return (
              <div
                key={m.i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 14px',
                  borderTop: i ? '1px solid #E2E8F0' : 'none',
                  margin: '0 -8px',
                  borderRadius: current ? 10 : 0,
                  background: current ? '#E8F1FB' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: done ? '#18B5A8' : current ? '#1E5AA8' : '#F1F3F5',
                    color: done || current ? '#fff' : '#94A3B8',
                    display: 'grid',
                    placeItems: 'center',
                    fontFamily: 'Sora',
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {done ? (
                    <Icon name="check" size={16} />
                  ) : m.locked ? (
                    <Icon name="lock" size={14} />
                  ) : (
                    m.i
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: m.locked ? '#94A3B8' : '#0D1B2A',
                    }}
                  >
                    {m.title}
                  </div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>
                    {m.dur} ·{' '}
                    {done
                      ? 'Completado'
                      : current
                        ? 'En curso'
                        : m.locked
                          ? 'Requiere completar el anterior'
                          : 'Pendiente'}
                  </div>
                </div>
                {current ? (
                  <Button size="sm" variant="primary" icon="play">
                    Reanudar
                  </Button>
                ) : done ? (
                  <Button size="sm" variant="ghost">
                    Repasar
                  </Button>
                ) : m.locked ? null : (
                  <Button size="sm" variant="secondary">
                    Empezar
                  </Button>
                )}
              </div>
            );
          })}
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: '#E8F1FB',
                  color: '#1E5AA8',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <Icon name="sparkles" size={18} />
              </div>
              <div style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14, color: '#0D1B2A' }}>
                Asistente Didacta
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.5, margin: '0 0 12px' }}>
              Resume el módulo 3, prepara una rúbrica o genera preguntas para tu equipo en segundos.
            </p>
            <Button variant="secondary" size="sm" style={{ width: '100%' }}>
              Abrir asistente
            </Button>
          </Card>

          <Card>
            <h4
              style={{
                fontFamily: 'Inter',
                fontWeight: 600,
                fontSize: 14,
                color: '#0D1B2A',
                margin: '0 0 12px',
              }}
            >
              Imparte
            </h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg,#2E7DCE,#1E5AA8)',
                  color: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'Sora',
                  fontWeight: 700,
                }}
              >
                JM
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0D1B2A' }}>Julia Mendoza</div>
                <div style={{ fontSize: 12, color: '#64748B' }}>Coach ejecutiva · 14 cursos</div>
              </div>
            </div>
          </Card>

          <Card style={{ background: '#0D1B2A', borderColor: '#0D1B2A', color: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <Icon name="shield" size={18} stroke="#18B5A8" />
              <div style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14 }}>Cumplimiento</div>
            </div>
            <p
              style={{
                fontSize: 13,
                color: 'rgba(255,255,255,.72)',
                lineHeight: 1.5,
                margin: '0 0 12px',
              }}
            >
              Curso registrado para auditoría interna. Tu progreso queda trazado.
            </p>
            <a style={{ fontSize: 13, color: '#2E7DCE', fontWeight: 600 }}>
              Ver registro de actividad →
            </a>
          </Card>
        </div>
      </div>
    </div>
  );
}

window.CourseDetail = CourseDetail;
