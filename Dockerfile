
FROM zenato/puppeteer as build
USER 0
RUN mkdir /app
WORKDIR /app
COPY package.json package-lock.json /app/
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 npm ci
COPY blocked.json index.html index.js start.sh ./
ENV NODE_ENV="production"

EXPOSE 3000
ENV CHROME_BIN /usr/bin/google-chrome-stable
USER pptruser

CMD ["./start.sh"]
