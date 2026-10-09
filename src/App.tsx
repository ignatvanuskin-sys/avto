import { NavLink, Route, Routes } from 'react-router-dom';
import { CalendarDays, Ticket, UserRound } from 'lucide-react';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Directory } from '@/screens/Directory';
import { NotFoundScreen } from '@/screens/NotFoundScreen';
import { StudioHome } from '@/screens/StudioHome';
import { BookingAccessScreen } from '@/screens/BookingAccessScreen';
import { OwnerScreen } from '@/screens/OwnerScreen';
import { readBootPayload, readSlugFromLocation, useTenant } from '@/tenant/TenantProvider';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  /** Astryx's built-in icon set has no ticket/person glyph, so these pass SVG components. */
  icon: typeof CalendarDays;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Запись', icon: CalendarDays, end: true },
  { to: '/booking', label: 'Моя запись', icon: Ticket },
  { to: '/owner', label: 'Кабинет', icon: UserRound },
];

/**
 * Mobile-first bottom navigation. It is always visible inside a studio, so
 * "back" out of a modal never strands the user, and iOS gets the home-bar inset.
 */
function BottomNav() {
  return (
    <nav
      aria-label="Основная навигация"
      className="sticky bottom-0 z-40 border-t border-default bg-surface/95 backdrop-blur pb-safe"
    >
      <HStack gap={1} justify="between" padding={2}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={Boolean(item.end)}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 text-center no-underline',
                isActive ? 'text-tenant-accent' : 'text-secondary',
              )
            }
          >
            <Icon icon={item.icon} />
            <Text type="supporting">{item.label}</Text>
          </NavLink>
        ))}
      </HStack>
    </nav>
  );
}

function StudioShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex-1 pt-safe">{children}</main>
      <BottomNav />
    </div>
  );
}

export function App() {
  const boot = readBootPayload();
  const tenant = useTenant();
  const slug = readSlugFromLocation();

  // Without a studio in the shell payload this is either the root directory
  // deployment or a path outside any studio. The directory is served only at
  // "/" — every other path is a real 404 instead of a silent redirect, so a
  // broken link is visible to the user and to a crawler.
  if (!boot) {
    return (
      <Routes>
        <Route path="/" element={<Directory />} />
        <Route
          path="*"
          element={
            <NotFoundScreen
              reason={
                slug
                  ? `Студия «${slug}» не найдена.`
                  : 'Такой страницы нет.'
              }
              hint="Проверьте ссылку или откройте список студий."
            />
          }
        />
      </Routes>
    );
  }

  // The shell exists but its configuration could not be loaded — for example a
  // studio that was renamed, suspended, or is not published in this deployment.
  // Rendering the booking screens here would show an empty shell, so say so.
  const unknownStudio =
    !tenant.isLoading && tenant.error === null && tenant.profile === null;

  if (unknownStudio) {
    return (
      <StudioShell>
        <NotFoundScreen
          reason="Эта студия не найдена или снята с публикации."
          hint="Откройте список студий и выберите другую."
        />
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <Routes>
        <Route path="/" element={<StudioHome />} />
        <Route path="/booking" element={<BookingAccessScreen />} />
        <Route path="/owner/*" element={<OwnerScreen />} />
        <Route
          path="*"
          element={<NotFoundScreen reason="Такого раздела в студии нет." />}
        />
      </Routes>
    </StudioShell>
  );
}
