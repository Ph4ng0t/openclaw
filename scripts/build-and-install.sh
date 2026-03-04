#!/bin/bash
pnpm build
pnpm ui:build
npm install -g . --prefix $HOME/.local
