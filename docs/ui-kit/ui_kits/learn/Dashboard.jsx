/* eslint-disable react/no-unknown-property */

function Dashboard({ onOpenCourse }) {
  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Greeting */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 28,
        }}
      >
        <div>
          <div style={{ fontSize: 14, color: '#64748B', fontWeight: 500, marginBottom: 6 }}>
            Lunes, 27 de abril
          </div>
          <h1
            style={{
              fontFamily: 'Sora',
              fontWeight: 800,
              fontSize: 36,
              color: '#0D1B2A',
              margin: 0,
              letterSpacing: '-0.02em',
            }}
          >
            Hola, Ana 👋
          </h1>
          <p style={{ fontFamily: 'Inter', fontSize: 16, color: '#475569', marginTop: 8 }}>
            Continúa donde lo dejaste. Tienes{' '}
            <b style={{ color: '#0D1B2A' }}>3 actividades pendientes</b> esta semana.
          </p>
        </div>
        <Button variant="secondary" icon="calendar">
          Ver agenda
        </Button>
      </div>

      {/* Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
          marginBottom: 28,
        }}
      >
        <StatCard label="Cursos activos" value="4" delta="+1 esta semana" icon="book" />
        <StatCard
          label="Horas formadas"
          value="24h"
          delta="+3.5h vs semana anterior"
          icon="clock"
        />
        <StatCard label="Progreso medio" value="62%" delta="+8 pts" icon="trending" />
        <StatCard label="Certificados" value="7" delta="2 nuevos" icon="award" />
      </div>

      {/* AI suggestion strip */}
      <Card
        style={{
          marginBottom: 28,
          padding: 20,
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          background: '#F8FAFC',
          borderColor: '#E2E8F0',
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: '#E8F1FB',
            color: '#1E5AA8',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <Icon name="sparkles" size={22} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14, color: '#0D1B2A' }}>
              Sugerido por Didacta
            </span>
            <Badge tone="info" style={{ fontSize: 10, padding: '2px 8px' }}>
              IA
            </Badge>
          </div>
          <div style={{ fontSize: 14, color: '#475569', lineHeight: 1.45 }}>
            Basado en tu progreso, te recomendamos completar{' '}
            <b style={{ color: '#0D1B2A' }}>Negociación avanzada</b> antes del 15 de mayo.
          </div>
        </div>
        <Button variant="ghost" icon="arrow-r">
          Ver ruta
        </Button>
      </Card>

      {/* Continue learning */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 16,
        }}
      >
        <h2
          style={{ fontFamily: 'Sora', fontWeight: 700, fontSize: 22, color: '#0D1B2A', margin: 0 }}
        >
          Continúa donde lo dejaste
        </h2>
        <a style={{ fontSize: 14, color: '#1E5AA8', fontWeight: 600, cursor: 'pointer' }}>
          Ver todos →
        </a>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
          marginBottom: 32,
        }}
      >
        {COURSES.map((c) => (
          <CourseCard key={c.id} course={c} onOpen={onOpenCourse} />
        ))}
      </div>

      {/* Two-up: agenda + activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
        <Card>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h3
              style={{
                fontFamily: 'Sora',
                fontWeight: 600,
                fontSize: 18,
                color: '#0D1B2A',
                margin: 0,
              }}
            >
              Próximas sesiones
            </h3>
            <Badge tone="neutral">Esta semana</Badge>
          </div>
          {[
            {
              day: 'MAR',
              date: 28,
              title: 'Sesión en directo: Liderazgo',
              meta: '10:00 – 11:30 · Aula virtual',
              tone: 'info',
            },
            {
              day: 'MIÉ',
              date: 29,
              title: 'Evaluación: RGPD módulo 3',
              meta: '14:00 · Entrega obligatoria',
              tone: 'warn',
            },
            {
              day: 'VIE',
              date: 1,
              title: 'Mentoring con Carla Núñez',
              meta: '12:00 – 12:45',
              tone: 'info',
            },
          ].map((e, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 0',
                borderTop: i ? '1px solid #E2E8F0' : 'none',
              }}
            >
              <div
                style={{
                  width: 52,
                  textAlign: 'center',
                  padding: '6px 0',
                  borderRadius: 10,
                  background: '#F1F3F5',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: '#64748B',
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                  }}
                >
                  {e.day}
                </div>
                <div
                  style={{ fontFamily: 'Sora', fontSize: 18, fontWeight: 700, color: '#0D1B2A' }}
                >
                  {e.date}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0D1B2A' }}>{e.title}</div>
                <div style={{ fontSize: 13, color: '#64748B' }}>{e.meta}</div>
              </div>
              <Badge tone={e.tone} dot>
                {e.tone === 'warn' ? 'Pendiente' : 'Confirmado'}
              </Badge>
            </div>
          ))}
        </Card>

        <Card>
          <h3
            style={{
              fontFamily: 'Sora',
              fontWeight: 600,
              fontSize: 18,
              color: '#0D1B2A',
              margin: '0 0 16px 0',
            }}
          >
            Actividad de tu equipo
          </h3>
          {[
            {
              who: 'Marta R.',
              initials: 'MR',
              what: 'completó',
              tgt: 'Comunicación efectiva',
              when: 'hace 2h',
              icon: 'check',
              tone: '#18B5A8',
            },
            {
              who: 'Diego L.',
              initials: 'DL',
              what: 'comentó en',
              tgt: 'Liderazgo · Módulo 3',
              when: 'hace 5h',
              icon: 'message',
              tone: '#1E5AA8',
            },
            {
              who: 'Carla N.',
              initials: 'CN',
              what: 'recibió un certificado',
              tgt: 'RGPD para formadores',
              when: 'ayer',
              icon: 'award',
              tone: '#0F8077',
            },
            {
              who: 'Tu equipo',
              initials: 'EQ',
              what: 'subió 12 puntos',
              tgt: 'en progreso medio',
              when: 'esta semana',
              icon: 'trending',
              tone: '#1E5AA8',
            },
          ].map((a, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 0',
                borderTop: i ? '1px solid #E2E8F0' : 'none',
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: '#E8F1FB',
                  color: '#1E5AA8',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'Sora',
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {a.initials}
              </div>
              <div style={{ flex: 1, fontSize: 13, color: '#1F2A3A', lineHeight: 1.4 }}>
                <b style={{ color: '#0D1B2A' }}>{a.who}</b> {a.what}{' '}
                <b style={{ color: '#0D1B2A' }}>{a.tgt}</b>
                <div style={{ fontSize: 12, color: '#94A3B8' }}>{a.when}</div>
              </div>
              <Icon name={a.icon} size={16} stroke={a.tone} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
