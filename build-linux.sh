#!/usr/bin/env bash
# 交叉编译 Linux 服务器二进制（在装有 Go 的机器上执行）
set -e
cd "$(dirname "$0")"
GOOS=linux GOARCH=amd64 go build -o chatnogpt-linux .
echo "Built chatnogpt-linux (linux/amd64)"
