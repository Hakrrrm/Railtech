// Keep authoritative bookings visible until the operator approves their moves.
export function withRescheduleOverlays(bookings, plan) {
  if (!plan || plan.kind !== 'reschedule') return bookings
  const originals = new Map(bookings.map((booking) => [booking.id, booking]))
  const overlays = (plan.bookings || []).flatMap((move) => {
    const original = originals.get(move.bookingId || move.original?.id)
    if (!original || original.status !== 'confirmed') return []
    return [{ ...original, id: `reschedule-preview-${original.id}`, bay_id: move.bayId, start_at: move.startAt, end_at: move.endAt, status: 'proposed', rescheduleOverlay: true }]
  })
  return [...bookings, ...overlays]
}
