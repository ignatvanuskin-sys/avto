/**
 * `/owner` — the studio cabinet.
 *
 * Access is by Supabase Auth only; membership is verified on the server, and
 * there is deliberately no public sign-up. Every mutation calls an RPC that
 * re-checks the role, so hiding a control in the UI is never the only defence.
 *
 * The cabinet is designed for a phone held in one hand: a compact statistics
 * block, today's list, and the few actions an owner actually performs between
 * cars.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { AsyncState } from '@/components/AsyncState';
import { getSupabase } from '@/lib/backend';
import {
  askAssistant,
  fetchAiUsage,
  fetchNotificationJobs,
  fetchOwnerBookings,
  fetchOwnerContext,
  fetchOwnerOccupancies,
  fetchOwnerStats,
  ownerBlockResource,
  ownerReleaseOccupancy,
  ownerSetBookingStatus,
  ownerSetServiceActive,
  ownerSetServicePrice,
  ownerSetTenantStatus,
} from '@/lib/api';
import { formatDay, formatMoney, formatTime, statusLabel, todayInZone, addDaysToIsoDate } from '@/lib/format';
import { clearPrivateState } from '@/pwa/register';
import type { OwnerTenantContext } from '@shared/tenant-types';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const supabase = getSupabase();
    if (!supabase) {
      setError('Приложение не подключено к базе данных.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError('Не удалось войти. Проверьте почту и пароль.');
      return;
    }
    onSignedIn();
  };

  return (
    <Section padding={4}>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={1}>Кабинет студии</Heading>
          <Text type="supporting" as="p">
            Вход для сотрудников. Учётные записи создаёт владелец студии — самостоятельная
            регистрация отключена.
          </Text>
        </VStack>

        {error ? <Banner status="error" title="Вход не выполнен" description={error} /> : null}

        <TextInput label="E-mail" value={email} onChange={setEmail} type="email" isRequired autoComplete="email" />
        <TextInput label="Пароль" value={password} onChange={setPassword} type="password" isRequired autoComplete="current-password" />
        <Button
          label="Войти"
          variant="primary"
          width="100%"
          isLoading={busy}
          clickAction={submit}
        />
      </VStack>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
function StatsBlock({ tenantId, timezone }: { tenantId: string; timezone: string }) {
  const today = todayInZone(timezone);
  const from = addDaysToIsoDate(today, -6);

  const stats = useQuery({
    queryKey: ['owner-stats', tenantId, from, today],
    queryFn: () => fetchOwnerStats(tenantId, from, today),
  });

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>За последние 7 дней</Heading>

        {stats.isError ? (
          <Banner status="error" title="Статистика недоступна" description={(stats.error as Error).message} />
        ) : null}

        <AsyncState isLoading={stats.isLoading} error={null}>
          {stats.data ? (
            <VStack gap={3}>
              <VStack gap={2}>
                <HStack justify="between">
                  <Text type="supporting">Заезды</Text>
                  <Text hasTabularNumbers>{stats.data.visits}</Text>
                </HStack>
                <HStack justify="between">
                  <Text type="supporting">Выполнено заказов</Text>
                  <Text hasTabularNumbers>{stats.data.completedOrders}</Text>
                </HStack>
                <HStack justify="between">
                  <Text type="supporting">Получено платежей</Text>
                  <Text hasTabularNumbers>
                    {formatMoney(stats.data.receivedPaymentsCents, stats.data.currency)}
                  </Text>
                </HStack>
                <HStack justify="between">
                  <Text type="supporting">Стоимость выполненных без оплаты</Text>
                  <Text hasTabularNumbers>
                    {formatMoney(stats.data.outstandingCents, stats.data.currency)}
                  </Text>
                </HStack>
              </VStack>

              {/* Deliberately worded as scheduled value, never as revenue. */}
              <Section padding={3} variant="muted">
                <VStack gap={1}>
                  <Text type="supporting">
                    Запланировано (не выручка):{' '}
                    {formatMoney(stats.data.scheduledValueCents, stats.data.currency)}
                  </Text>
                  <Text type="supporting" as="p">
                    {stats.data.scheduledNote}
                  </Text>
                  <Text type="supporting">
                    Загрузка: {stats.data.capacity.utilization}% · период в {stats.data.period.timezone}
                  </Text>
                </VStack>
              </Section>
            </VStack>
          ) : null}
        </AsyncState>
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Today's bookings
// ---------------------------------------------------------------------------
function BookingsList({ tenantId, timezone }: { tenantId: string; timezone: string }) {
  const queryClient = useQueryClient();

  const bookings = useQuery({
    // The window is relative to "now", so it is resolved inside the query rather
    // than during render: reading the clock while rendering is impure and would
    // make the component's output depend on when React happens to re-render.
    queryKey: ['owner-bookings', tenantId],
    queryFn: () => {
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
      return fetchOwnerBookings(tenantId, from, to);
    },
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: 'confirmed' | 'completed' | 'no_show' | 'cancelled' }) =>
      ownerSetBookingStatus(tenantId, input.id, input.status),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['owner-bookings', tenantId] });
      await queryClient.invalidateQueries({ queryKey: ['owner-stats', tenantId] });
    },
  });

  const rows = useMemo(() => bookings.data ?? [], [bookings.data]);

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Записи</Heading>

        <AsyncState
          isLoading={bookings.isLoading}
          error={bookings.error}
          isEmpty={rows.length === 0}
          emptyTitle="Записей нет"
          emptyDescription="Как только клиент запишется, запись появится здесь."
          onRetry={() => {
            void bookings.refetch();
          }}
        >
          <VStack gap={3}>
            {rows.map((row) => (
              <Section key={row.id} padding={3} variant="muted">
                <VStack gap={2}>
                  <HStack gap={2} justify="between" align="center">
                    <Text weight="medium">
                      {formatDay(row.starts_at, timezone)} · {formatTime(row.starts_at, timezone)}
                    </Text>
                    <HStack gap={1} align="center">
                      {row.is_demo ? <Badge label="демо" /> : null}
                      <Badge
                        label={statusLabel(row.status).label}
                        variant={
                          statusLabel(row.status).tone === 'good'
                            ? 'success'
                            : statusLabel(row.status).tone === 'bad'
                              ? 'error'
                              : 'neutral'
                        }
                      />
                    </HStack>
                  </HStack>

                  <Text type="supporting" as="p">
                    {row.service_name}
                    {row.resource_name ? ` · ${row.resource_name}` : ''}
                  </Text>
                  <Text type="supporting" as="p">
                    {row.customer_name ?? '—'} · {row.customer_phone ?? '—'} ·{' '}
                    {formatMoney(row.price_cents, row.currency)}
                  </Text>

                  <HStack gap={2}>
                    <Button
                      label="Выполнено"
                      variant="secondary"
                      size="sm"
                      isDisabled={row.status === 'completed'}
                      clickAction={() => setStatus.mutateAsync({ id: row.id, status: 'completed' })}
                    />
                    <Button
                      label="Не приехал"
                      variant="ghost"
                      size="sm"
                      clickAction={() => setStatus.mutateAsync({ id: row.id, status: 'no_show' })}
                    />
                    <Button
                      label="Отменить"
                      variant="destructive"
                      size="sm"
                      clickAction={() => setStatus.mutateAsync({ id: row.id, status: 'cancelled' })}
                    />
                  </HStack>
                </VStack>
              </Section>
            ))}
          </VStack>
        </AsyncState>
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Schedule: blocks
// ---------------------------------------------------------------------------
function ScheduleBlock({ tenantId, timezone }: { tenantId: string; timezone: string }) {
  const queryClient = useQueryClient();
  const [resourceId, setResourceId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('Закрыто');
  const [message, setMessage] = useState<string | null>(null);

  const occupancies = useQuery({
    queryKey: ['owner-occupancies', tenantId],
    queryFn: () => {
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
      return fetchOwnerOccupancies(tenantId, from, to);
    },
  });

  const resources = useQuery({
    queryKey: ['owner-resources', tenantId],
    queryFn: async () => {
      const supabase = getSupabase();
      if (!supabase) return [];
      const { data, error } = await supabase
        .from('resources')
        .select('id, name, kind, is_active')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('sort_order');
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string; kind: string }>;
    },
  });

  const block = useMutation({
    mutationFn: () =>
      ownerBlockResource({
        tenantId,
        resourceId,
        // The owner types a local wall-clock time; convert via the studio zone.
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        reason,
      }),
    onSuccess: async () => {
      setMessage('Интервал заблокирован.');
      await queryClient.invalidateQueries({ queryKey: ['owner-occupancies', tenantId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const release = useMutation({
    mutationFn: (occupancyId: string) => ownerReleaseOccupancy(tenantId, occupancyId),
    onSuccess: async () => {
      setMessage('Блокировка снята.');
      await queryClient.invalidateQueries({ queryKey: ['owner-occupancies', tenantId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const blocks = (occupancies.data ?? []).filter((row) => row.kind === 'block');

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Расписание и блокировки</Heading>
        {message ? <Banner status="info" title={message} /> : null}

        <VStack gap={2}>
          <Text type="supporting">Пост или зона</Text>
          <HStack gap={2} wrap="wrap">
            {(resources.data ?? []).map((resource) => (
              <Button
                key={resource.id}
                label={resource.name}
                size="sm"
                variant={resourceId === resource.id ? 'primary' : 'secondary'}
                onClick={() => setResourceId(resource.id)}
              />
            ))}
          </HStack>
        </VStack>

        <TextInput
          label="Начало (ISO, локальное время студии)"
          value={startsAt}
          onChange={setStartsAt}
          description={`Часовой пояс студии: ${timezone}`}
        />
        <TextInput label="Окончание" value={endsAt} onChange={setEndsAt} />
        <TextInput label="Причина" value={reason} onChange={setReason} />

        <Button
          label="Заблокировать"
          variant="primary"
          width="100%"
          isDisabled={!resourceId || !startsAt || !endsAt}
          isLoading={block.isPending}
          clickAction={async () => {
            await block.mutateAsync();
          }}
        />

        {blocks.length > 0 ? (
          <VStack gap={2}>
            <Text type="supporting">Активные блокировки</Text>
            {blocks.map((row) => (
              <HStack key={row.id} justify="between" align="center" gap={2}>
                <Text type="supporting">
                  {row.resource_name} · {formatDay(row.starts_at, timezone)}{' '}
                  {formatTime(row.starts_at, timezone)}—{formatTime(row.ends_at, timezone)} ·{' '}
                  {row.block_reason}
                </Text>
                <Button
                  label="Снять"
                  size="sm"
                  variant="ghost"
                  clickAction={() => release.mutateAsync(row.id)}
                />
              </HStack>
            ))}
          </VStack>
        ) : (
          <Text type="supporting">Активных блокировок нет.</Text>
        )}
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Catalogue and status
// ---------------------------------------------------------------------------
function CatalogueBlock({ tenantId, timezone }: { tenantId: string; timezone: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const services = useQuery({
    queryKey: ['owner-services', tenantId],
    queryFn: async () => {
      const supabase = getSupabase();
      if (!supabase) return [];
      const { data, error } = await supabase
        .from('services')
        .select('id, key, name, price_cents, currency, is_active')
        .eq('tenant_id', tenantId)
        .order('sort_order');
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        key: string;
        name: string;
        price_cents: number;
        currency: string;
        is_active: boolean;
      }>;
    },
  });

  const setPrice = useMutation({
    mutationFn: (input: { key: string; cents: number }) =>
      ownerSetServicePrice(tenantId, input.key, input.cents),
    onSuccess: async () => {
      setMessage('Цена обновлена. Уже созданные записи сохраняют прежнюю стоимость.');
      await queryClient.invalidateQueries({ queryKey: ['owner-services', tenantId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const setActive = useMutation({
    mutationFn: (input: { key: string; isActive: boolean }) =>
      ownerSetServiceActive(tenantId, input.key, input.isActive),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['owner-services', tenantId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Услуги и цены</Heading>
        {message ? <Banner status="info" title={message} /> : null}

        <AsyncState isLoading={services.isLoading} error={services.error} isEmpty={(services.data ?? []).length === 0}>
          <VStack gap={3}>
            {(services.data ?? []).map((service) => (
              <Section key={service.id} padding={3} variant="muted">
                <VStack gap={2}>
                  <HStack justify="between" align="center">
                    <Text weight="medium">{service.name}</Text>
                    <Badge label={service.is_active ? 'включена' : 'скрыта'} />
                  </HStack>
                  <NumberInput
                    label={`Цена, ${service.currency}`}
                    value={service.price_cents / 100}
                    onChange={(value: number) =>
                      setPrice.mutate({ key: service.key, cents: Math.round(value * 100) })
                    }
                    min={0}
                    step={100}
                  />
                  <Button
                    label={service.is_active ? 'Скрыть из записи' : 'Вернуть в запись'}
                    variant="ghost"
                    size="sm"
                    clickAction={() =>
                      setActive.mutateAsync({ key: service.key, isActive: !service.is_active })
                    }
                  />
                </VStack>
              </Section>
            ))}
          </VStack>
        </AsyncState>

        <Text type="supporting" as="p">
          Часовой пояс студии: {timezone}. Изменение расписания меняет моменты приёма, но не
          переносит уже созданные записи.
        </Text>
      </VStack>
    </Card>
  );
}

function StatusBlock({ tenant }: { tenant: OwnerTenantContext }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: ['owner-jobs', tenant.tenantId],
    queryFn: () => fetchNotificationJobs(tenant.tenantId),
  });

  const usage = useQuery({
    queryKey: ['owner-ai-usage', tenant.tenantId],
    queryFn: () => fetchAiUsage(tenant.tenantId),
  });

  const setStatus = useMutation({
    mutationFn: (status: 'preview' | 'live') => ownerSetTenantStatus(tenant.tenantId, status),
    onSuccess: async (data) => {
      setMessage(
        data.status === 'live'
          ? 'Студия переведена в рабочий режим: уведомления включены.'
          : 'Студия возвращена в демо-режим: реальные уведомления не отправляются.',
      );
      await queryClient.invalidateQueries();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const todayUsage = usage.data?.[0];

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Состояние</Heading>
        {message ? <Banner status="info" title={message} /> : null}

        <HStack justify="between" align="center">
          <Text type="supporting">Режим</Text>
          <Badge label={tenant.status === 'live' ? 'Рабочий' : 'Демо'} variant={tenant.status === 'live' ? 'success' : 'warning'} />
        </HStack>

        <Button
          label={tenant.status === 'live' ? 'Вернуть в демо-режим' : 'Перевести в рабочий режим'}
          variant={tenant.status === 'live' ? 'ghost' : 'primary'}
          width="100%"
          isLoading={setStatus.isPending}
          clickAction={async () => {
            await setStatus.mutateAsync(tenant.status === 'live' ? 'preview' : 'live');
          }}
        />

        <VStack gap={2}>
          <Text type="supporting">Исходящие уведомления (последние 60)</Text>
          {jobs.isError ? (
            <Text type="supporting">Не удалось прочитать очередь: {(jobs.error as Error).message}</Text>
          ) : null}
          {(jobs.data ?? []).slice(0, 12).map((job) => (
            <HStack key={job.id} justify="between" gap={2}>
              <Text type="supporting">
                {job.kind} · {job.channel}
              </Text>
              <Badge
                label={`${job.status} · ${job.attempts}/${job.max_attempts}`}
                variant={job.status === 'sent' ? 'success' : job.status === 'dead' ? 'error' : 'neutral'}
              />
            </HStack>
          ))}
          {(jobs.data ?? []).length === 0 && !jobs.isLoading ? (
            <Text type="supporting">Очередь пуста.</Text>
          ) : null}
        </VStack>

        <VStack gap={1}>
          <Text type="supporting">Бюджет помощника</Text>
          <Text type="supporting">
            {todayUsage
              ? `${todayUsage.calls} вызовов, ${todayUsage.prompt_tokens + todayUsage.completion_tokens} токенов за последние сутки`
              : 'Пока не использовался'}
          </Text>
        </VStack>
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
function AssistantPanel({ tenant }: { tenant: OwnerTenantContext }) {
  const [message, setMessage] = useState('');
  const [turns, setTurns] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: () =>
      askAssistant({
        slug: tenant.slug,
        scope: 'owner',
        message,
        history: turns.slice(-6),
      }),
    onSuccess: (reply) => {
      setTurns((previous) => [
        ...previous,
        { role: 'user' as const, content: message },
        { role: 'assistant' as const, content: reply.reply },
      ]);
      setMessage('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Помощник</Heading>
        <Text type="supporting" as="p">
          Спрашивает цифры у базы, а не у себя. Запись работает и без него.
        </Text>

        {turns.length === 0 ? (
          <Text type="supporting">Например: «сколько заездов было за неделю».</Text>
        ) : (
          <VStack gap={2}>
            {turns.map((turn, index) => (
              <Section key={index} padding={3} variant={turn.role === 'user' ? 'transparent' : 'muted'}>
                <Text as="p">{turn.content}</Text>
              </Section>
            ))}
          </VStack>
        )}

        {error ? <Banner status="warning" title="Помощник недоступен" description={error} /> : null}

        <TextInput label="Вопрос" value={message} onChange={setMessage} isOptional />
        <Button
          label="Спросить"
          variant="primary"
          width="100%"
          isDisabled={message.trim().length === 0}
          isLoading={ask.isPending}
          clickAction={async () => {
            await ask.mutateAsync();
          }}
        />
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Whether a Supabase client could be created at all. Resolved once when the
 * module loads, so the component's first render is a pure function of it.
 */
const backendAvailable = getSupabase() !== null;

export function OwnerScreen() {
  const queryClient = useQueryClient();
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  // Evaluated once at module scope: when no backend is configured there is no
  // session to wait for, so the screen can render its state immediately instead
  // of setting state synchronously inside an effect.
  const [isReady, setReady] = useState(backendAvailable);
  const [forceTenantId, setForceTenantId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSessionEmail(data.session?.user.email ?? null);
      setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user.email ?? null);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const context = useQuery({
    queryKey: ['owner-context', sessionEmail],
    enabled: isReady && Boolean(sessionEmail),
    queryFn: () => fetchOwnerContext(),
    retry: 0,
  });

  if (!isReady) {
    return (
      <Section padding={4}>
        <Text>Загрузка…</Text>
      </Section>
    );
  }

  if (!sessionEmail) {
    return <SignIn onSignedIn={() => void queryClient.invalidateQueries()} />;
  }

  const tenants = context.data ?? [];
  const active = tenants.find((tenant) => tenant.tenantId === forceTenantId) ?? tenants[0] ?? null;

  if (context.isLoading) {
    return <Section padding={4}><Text>Проверяем доступ…</Text></Section>;
  }

  if (context.error) {
    return (
      <Section padding={4}>
        <Banner
          status="error"
          title="Доступ не подтверждён"
          description={`${(context.error as Error).message}. Проверьте, что учётная запись добавлена в студию.`}
        />
      </Section>
    );
  }

  if (!active) {
    return (
      <Section padding={4}>
        <Banner
          status="warning"
          title="Нет доступа к студиям"
          description="Эта учётная запись не является участником ни одной студии. Попросите владельца добавить вас."
        />
      </Section>
    );
  }

  return (
    <Section padding={4}>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={1}>{active.name}</Heading>
          <Text type="supporting" as="p">
            {sessionEmail} · роль {active.role}
          </Text>
        </VStack>

        {tenants.length > 1 ? (
          <HStack gap={2} wrap="wrap">
            {tenants.map((tenant) => (
              <Button
                key={tenant.tenantId}
                label={tenant.name}
                size="sm"
                variant={tenant.tenantId === active.tenantId ? 'primary' : 'secondary'}
                onClick={() => setForceTenantId(tenant.tenantId)}
              />
            ))}
          </HStack>
        ) : null}

        <VStack gap={5}>
          <StatsBlock tenantId={active.tenantId} timezone={active.timezone} />
          <BookingsList tenantId={active.tenantId} timezone={active.timezone} />
          <ScheduleBlock tenantId={active.tenantId} timezone={active.timezone} />
          <CatalogueBlock tenantId={active.tenantId} timezone={active.timezone} />
          <AssistantPanel tenant={active} />
          <StatusBlock tenant={active} />
        </VStack>

        <Button
          label="Выйти"
          variant="ghost"
          width="100%"
          clickAction={async () => {
            // Private caches are cleared before the session goes away.
            await clearPrivateState();
            await getSupabase()?.auth.signOut();
            queryClient.clear();
          }}
        />
      </VStack>
    </Section>
  );
}
