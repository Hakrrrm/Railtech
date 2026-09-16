import { describe, expect, it } from 'vitest'
import { OCR_CONFIDENCE_THRESHOLD, requiresManualOcrReview } from './technician'

describe('technician OCR review gate', () => {
  it('requires a manual check below the configured confidence threshold', () => {
    expect(requiresManualOcrReview(OCR_CONFIDENCE_THRESHOLD - 0.0001)).toBe(true)
    expect(requiresManualOcrReview(OCR_CONFIDENCE_THRESHOLD)).toBe(false)
    expect(requiresManualOcrReview(0.99)).toBe(false)
  })

  it('fails closed when confidence is missing or invalid', () => {
    expect(requiresManualOcrReview(undefined)).toBe(true)
    expect(requiresManualOcrReview('not-a-score')).toBe(true)
  })
})
