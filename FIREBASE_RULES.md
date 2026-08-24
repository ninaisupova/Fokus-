# Фокус+ — вход фотографа и правила Firebase

## Что изменилось

- Кабинет (`index.html`) — вход по email/паролю.
- Полный календарь: `/v2/focus/КОД/admin` (только вошедший фотограф).
- Запись клиентов: `/v2/focus/КОД/public` (без пароля, без чужих телефонов и сумм).
- Старые данные `/focus/КОД` при первом входе переносятся автоматически.

## Шаги в Firebase Console

### 1. Authentication → Email/Password

1. [console.firebase.google.com](https://console.firebase.google.com/) → проект **fokus-plus**
2. **Build → Authentication → Sign-in method**
3. **Email/Password** → Enable → Save
4. **Users → Add user** — ваш email и пароль для кабинета

### 2. Web API Key

1. Шестерёнка → **Project settings**
2. Скопируйте **Web API Key**
3. Вставьте в `js/cloud-config.js`:

```js
apiKey: 'ВАШ_КЛЮЧ',
```

4. Залейте на GitHub (или попросите ассистента вставить ключ и запушить)

### 3. Rules → Publish

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "focus": {
      "$code": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "v2": {
      "focus": {
        "$code": {
          "admin": {
            ".read": "auth != null",
            ".write": "auth != null"
          },
          "public": {
            ".read": true,
            ".write": true
          }
        }
      }
    }
  }
}
```

`focus` оставлен для чтения старых данных при переносе. `v2` — новая схема.

### 4. Проверка

1. Обновите кабинет → войдите email/паролем  
2. Нажмите «Синхронизировать сейчас»  
3. Проверьте запись по ссылке из VK  

## Важно

- Ссылку в VK менять не нужно (тот же `?c=`).
- Без apiKey и пользователя вход не заработает.
- После Publish Rules без входа кабинет не увидит облако — это нормально.
