/* Фокус+ — настройки облака
 * 1) databaseURL — из Firebase → Realtime Database
 * 2) apiKey — Web API Key из Firebase → Project settings → Your apps
 *    (см. FIREBASE_RULES.md)
 */
window.FOCUS_CLOUD = {
  databaseURL: 'https://fokus-plus-default-rtdb.firebaseio.com',
  apiKey: '', // ← вставьте Web API Key из Firebase Console
  requireAuth: true,
};
