# 軽量・LTS の Alpine ベースに変更し、攻撃面を縮小
FROM node:20-alpine

WORKDIR /usr/src/app

# 依存解決を先に行うことでレイヤキャッシュを最大化
COPY package*.json ./

# 本番依存のみインストールし、開発依存・キャッシュを含めない
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# アプリ本体をコピー
COPY . .

# 非 root ユーザーで実行 (node イメージ標準ユーザー)
RUN chown -R node:node /usr/src/app
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD [ "node", "index.js" ]
