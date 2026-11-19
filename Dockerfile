FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV ADMIN_EMAILS=hamoda1020z@gmail.com
ENV SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qeWR6cW50eGJ3dm5yaHFmaG1lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjA1NzA3MiwiZXhwIjoyMTA3NjMzMDcyfQ.cFcjzDeOqfooFU7DzcryuzVT8TK3uzzb6SUWUUshKcs
ENV SUPABASE_URL=https://mjydzqntxbwvnrhqfhme.supabase.co
ENV RAPIDAPI_BIN_KEY=28ab3a3445msh4e87f2eee5443bep131842jsn70cf88cdf9f7
ENV SUPABASE_PUBLISHABLE_KEY=sb_secret_azOyf3XAcpQacxKWPDpREA_VX12l2tT
ENV SUPABASE_SECRET_KEY=sb_secret_azOyf3XAcpQacxKWPDpREA_VX12l2tT
WORKDIR /app

COPY package.json ./
COPY patches ./patches
RUN npm install --legacy-peer-deps

COPY . .
RUN test -f dist/index.js || npm run build

EXPOSE 3000
CMD ["npm", "start"]