export const OCR_CONFIDENCE_THRESHOLD = 0.85

export function requiresManualOcrReview(confidence) {
  const value = Number(confidence)
  return !Number.isFinite(value) || value < OCR_CONFIDENCE_THRESHOLD
}
