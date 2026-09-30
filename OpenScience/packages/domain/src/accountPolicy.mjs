/** The owner-approved floor for local account passwords, in Unicode characters. */
export const MIN_PASSWORD_LENGTH = 6

/** @param {unknown} password */
export function meetsPasswordMinimum(password) {
  return typeof password === 'string' && Array.from(password).length >= MIN_PASSWORD_LENGTH
}
