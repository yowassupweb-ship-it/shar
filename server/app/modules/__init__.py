"""Модули API. Каждый — своя папка: router.py (или несколько роутеров) + сервисный код.

Чтобы добавить модуль, подключите его роутер здесь: порядок важен только там, где
пути пересекаются (специфичный раньше шаблонного)."""

from __future__ import annotations

from fastapi import APIRouter


def _collect() -> list[APIRouter]:
    from app.modules.admin import router as admin
    from app.modules.auth import router as auth
    from app.modules.birthdays import router as birthdays
    from app.modules.calendar import router as calendar
    from app.modules.calendar import workdays as calendar_workdays
    from app.modules.chats import scheduled as chats_scheduled
    from app.modules.calls import rooms as calls_rooms
    from app.modules.calls import signaling as calls_signaling
    from app.modules.chats import chat_notifications, chats, inline, messages, receipts
    from app.modules.cloud import router as cloud
    from app.modules.departments import router as departments
    from app.modules.files import avatars, backgrounds, stickers, uploads
    from app.modules.integrations import router as integrations
    from app.modules.leads import router as leads
    from app.modules.mail import accounts, email_chat_rules, mailboxes
    from app.modules.mail import messages as mail_messages
    from app.modules.mail import sync as mail_sync
    from app.modules.mcp import keys as mcp_keys
    from app.modules.mcp import router as mcp
    from app.modules.notifications import router as notifications
    from app.modules.og import router as og
    from app.modules.ops import client_errors, health
    from app.modules.push import router as push
    from app.modules.realtime import router as realtime
    from app.modules.requests import router as requests_mod
    from app.modules.search import router as search
    from app.modules.social import router as social
    from app.modules.todos import router as todos
    from app.modules.users import router as users
    from app.modules.usage import router as usage
    from app.modules.utm import router as utm
    from app.modules.workspace import folders as workspace_folders
    from app.modules.workspace import public as workspace_public
    from app.modules.workspace import router as workspace
    from app.modules.core_chat import router as core_chat

    mods = [
        auth, users, departments, chats, messages, receipts, chat_notifications, inline,
        realtime, calls_rooms, calls_signaling, mail_messages, mail_sync, accounts, mailboxes, email_chat_rules,
        cloud, uploads, avatars, backgrounds, stickers, calendar_workdays, calendar, todos, notifications, push, requests_mod, admin,
        client_errors, health, utm, og, chats_scheduled, leads, social, integrations, workspace_folders, workspace, workspace_public, search, birthdays,
        mcp_keys, mcp, core_chat, usage,
    ]
    return [m.router for m in mods]


ROUTERS: list[APIRouter] = _collect()
