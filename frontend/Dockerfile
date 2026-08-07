FROM node:20-alpine

WORKDIR /app

# Installing deps in their own layer before copying the rest of the
# source keeps rebuilds fast -- this layer is cached unless
# package.json/package-lock.json change.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
