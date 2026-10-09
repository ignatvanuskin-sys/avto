/**
 * The booking path: service → moment → contacts → done.
 *
 * It is a single sequence of bottom sheets driven by `BottomSheetSwitcher`, so
 * the customer never loses the thread, Back always returns to the previous step,
 * and the sheet that collects personal data protects what has been typed
 * (`purpose="form"` plus an expanded `height="tall"` — the only configuration in
 * which the sheet keeps a focused field above the mobile keyboard).
 *
 * States: every network step has loading, error and empty handling, and the
 * confirm button reports a real failure instead of a spinner that never ends.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, BottomSheetSwitcher } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Text } from '@astryxdesign/core/Text';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Badge } from '@astryxdesign/core/Badge';
import { createBooking, fetchSlots, bookingIcsUrl } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { formatMoney, formatDay, formatTime, formatDuration, todayInZone, addDaysToIsoDate } from '@/lib/format';
import type { AvailabilitySlot, PublicService } from '@shared/tenant-types';

/**
 * Sheet ids of the sequence — `moment` → `contacts` → `done`. The switcher owns
 * which one is on top; screens only pass the id through.
 */

export interface BookingFlowProps {
  service: PublicService | null;
  isOpen: boolean;
  onClose: () => void;
  slug: string;
  timezone: string;
  leadMinutes: number;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Slots grouped by local day, so the sheet shows a readable list. */
function groupByDay(slots: AvailabilitySlot[], timezone: string) {
  const groups = new Map<string, AvailabilitySlot[]>();
  for (const slot of slots) {
    const key = formatDay(slot.slot_start, timezone);
    const list = groups.get(key) ?? [];
    list.push(slot);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

export function BookingFlow({
  service,
  isOpen,
  onClose,
  slug,
  timezone,
  leadMinutes,
}: BookingFlowProps) {
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [selected, setSelected] = useState<AvailabilitySlot | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [comment, setComment] = useState('');
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ bookingId: string; accessToken: string; startsAt: string; displayNumber: number } | null>(null);

  // One idempotency key per booking attempt: a retry after a flaky network
  // re-issues the SAME access instead of creating a second booking.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const from = todayInZone(timezone);
  const to = addDaysToIsoDate(from, 21);

  const slots = useQuery({
    queryKey: ['slots', slug, service?.key, from, to, leadMinutes],
    enabled: isOpen && Boolean(service) && slug.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      const found = await fetchSlots(slug, service!.key, from, to);
      // The server already enforces `booking_lead_minutes`; re-applying it here
      // stops a slightly stale cached list from offering a moment that has since
      // become too soon. It lives inside the query so nothing impure runs while
      // rendering.
      const earliest = Date.now() + leadMinutes * 60_000;
      return found.filter((slot) => new Date(slot.slot_start).getTime() >= earliest);
    },
  });

  const usableSlots = slots.data ?? [];

  const reset = () => {
    setSelected(null);
    setSubmitError(null);
    setResult(null);
    setIdempotencyKey(newIdempotencyKey());
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setActiveSheet('moment');
      return;
    }
    setActiveSheet(null);
    reset();
    onClose();
  };

  const submit = async () => {
    if (!service || !selected) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const booking = await createBooking({
        slug,
        serviceKey: service.key,
        startsAt: selected.slot_start,
        customerName: name.trim(),
        customerPhone: phone.trim(),
        ...(email.trim() ? { customerEmail: email.trim() } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        idempotencyKey,
      });

      setResult({
        bookingId: booking.bookingId,
        accessToken: booking.accessToken,
        startsAt: booking.startsAt,
        displayNumber: booking.displayNumber,
      });
      setActiveSheet('done');
      // Keep the access token so the customer can reopen the booking without
      // the original link.
      try {
        window.localStorage.setItem(`booking-access:${booking.bookingId}`, booking.accessToken);
      } catch {
        // storage may be unavailable; the link on the done step still works
      }
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error : new ApiError('UNKNOWN', String(error)));
      // The slot may have been taken while the form was open — refetch.
      void slots.refetch();
    } finally {
      setSubmitting(false);
    }
  };

  const accessUrl =
    result && typeof window !== 'undefined'
      ? `${window.location.origin}${window.__TENANT__?.basePath ?? '/'}booking?t=${encodeURIComponent(result.accessToken)}`
      : '';

  const icsUrl = result ? bookingIcsUrl(result.accessToken) : null;

  return (
    <BottomSheetSwitcher
      activeSheet={isOpen ? activeSheet : null}
      onActiveSheetChange={(next) => {
        if (next === null) {
          handleOpenChange(false);
        } else {
          setActiveSheet(next);
        }
      }}
      hasScrim
    >
      {/* ---------------------------------------------------------------- */}
      <BottomSheet sheetId="moment" label="Выбор времени" height="tall" padding={5}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>{service?.name ?? 'Запись'}</Heading>
            <Text type="supporting">
              {service
                ? `${formatDuration(service.durationMin)} · ${formatMoney(service.priceCents, service.currency)}`
                : ''}
            </Text>
          </VStack>

          {slots.isLoading ? (
            <VStack gap={2}>
              <Skeleton height={44} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </VStack>
          ) : null}

          {slots.isError ? (
            <Banner
              status="error"
              title="Не удалось получить свободные окна"
              description={(slots.error as Error)?.message ?? 'Повторите попытку.'}
            />
          ) : null}

          {!slots.isLoading && !slots.isError && usableSlots.length === 0 ? (
            <EmptyState
              title="Свободных окон нет"
              description="Попробуйте позже или позвоните в студию — возможно, окно освободится."
            />
          ) : null}

          <VStack gap={4}>
            {groupByDay(usableSlots, timezone).map(([day, daySlots]) => (
              <VStack key={day} gap={2}>
                <Text type="supporting">{day}</Text>
                <HStack gap={2} wrap="wrap">
                  {daySlots.map((slot) => {
                    const isChosen = selected?.slot_start === slot.slot_start;
                    return (
                      <Button
                        key={slot.slot_start}
                        label={formatTime(slot.slot_start, timezone)}
                        variant={isChosen ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => setSelected(slot)}
                      />
                    );
                  })}
                </HStack>
              </VStack>
            ))}
          </VStack>

          <HStack gap={2} justify="between">
            <Button label="Отмена" variant="ghost" onClick={() => handleOpenChange(false)} />
            <Button
              label="Далее"
              variant="primary"
              isDisabled={!selected}
              onClick={() => setActiveSheet('contacts')}
            />
          </HStack>
        </VStack>
      </BottomSheet>

      {/* ---------------------------------------------------------------- */}
      <BottomSheet
        sheetId="contacts"
        label="Контакты для записи"
        // form + an expanded tall sheet is the documented combination that
        // protects typed data and keeps the focused field above the keyboard.
        purpose="form"
        height="tall"
        padding={5}
      >
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Контактные данные</Heading>
            <Text type="supporting">
              {selected
                ? `${formatDay(selected.slot_start, timezone)}, ${formatTime(selected.slot_start, timezone)}`
                : ''}
            </Text>
          </VStack>

          <TextInput
            label="Имя"
            value={name}
            onChange={setName}
            isRequired
            autoComplete="name"
          />
          <TextInput
            label="Телефон"
            value={phone}
            onChange={setPhone}
            type="text"
            isRequired
            description="Нужен, чтобы студия подтвердила запись"
          />
          <TextInput label="E-mail" value={email} onChange={setEmail} type="email" isOptional />
          <TextInput label="Комментарий" value={comment} onChange={setComment} isOptional />

          {submitError ? (
            <Banner status="error" title="Запись не создана" description={submitError.friendly} />
          ) : null}

          <HStack gap={2} justify="between">
            <Button label="Назад" variant="ghost" onClick={() => setActiveSheet('moment')} />
            <Button
              label="Подтвердить запись"
              variant="primary"
              isLoading={isSubmitting}
              isDisabled={name.trim().length < 2 || phone.trim().length < 5}
              clickAction={submit}
            />
          </HStack>
        </VStack>
      </BottomSheet>

      {/* ---------------------------------------------------------------- */}
      <BottomSheet sheetId="done" label="Запись подтверждена" height="hug" padding={5}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Запись создана</Heading>
            <Text type="supporting">Номер записи {result?.displayNumber}</Text>
          </VStack>

          {result ? (
            <VStack gap={2}>
              <Badge label={`${formatDay(result.startsAt, timezone)}, ${formatTime(result.startsAt, timezone)}`} variant="success" />
              <Section padding={3} variant="muted">
                <Text type="supporting" as="p" wordBreak="break-all">
                  {accessUrl}
                </Text>
              </Section>
              <Text type="supporting" as="p">
                Сохраните ссылку: по ней можно посмотреть, перенести или отменить запись — без
                регистрации.
              </Text>
              {icsUrl ? (
                <Button
                  label="Добавить в календарь"
                  variant="secondary"
                  width="100%"
                  {...{ href: icsUrl }}
                />
              ) : null}
            </VStack>
          ) : null}

          <Button label="Готово" variant="primary" width="100%" onClick={() => handleOpenChange(false)} />
        </VStack>
      </BottomSheet>
    </BottomSheetSwitcher>
  );
}
