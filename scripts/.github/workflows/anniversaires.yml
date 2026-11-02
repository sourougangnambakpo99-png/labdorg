name: Rappel des anniversaires

on:
  schedule:
    - cron: '0 6 * * *'   # 06h00 UTC = 07h00 au Bénin
  workflow_dispatch:
    inputs:
      test:
        description: "Mode test (affiche sans envoyer)"
        type: boolean
        default: true

jobs:
  rappel:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install nodemailer@6 --no-save
      - run: node scripts/rappel-anniversaires.mjs
        env:
          GMAIL_USER: ${{ secrets.GMAIL_USER }}
          GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
          INDEX_PATH: index.html
          DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.test && '1' || '0' }}
