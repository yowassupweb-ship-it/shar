from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.camel import snake_to_camel
from app.core.db import db
from app.core.security import Identity, current_identity, require_admin

router = APIRouter()

logger = logging.getLogger(__name__)


@router.get("/api/departments")
def get_departments(me: Identity = Depends(current_identity)):
    """Получить список отделов из реальной таблицы departments"""
    try:
        departments = db.get_departments()
        return {"departments": [snake_to_camel(dept) for dept in departments]}
    except Exception as e:
        logger.error(f"Error fetching departments: {e}")
        return {"departments": []}


@router.post("/api/departments")
def create_department(payload: dict = Body(...), me: Identity = Depends(require_admin)):
    """Создать отдел"""
    name = (payload.get('name') or '').strip()
    if not name:
        raise HTTPException(status_code=400, detail="Название отдела обязательно")
    try:
        dept = db.add_department(name, payload.get('color'), parent_id=(payload.get('parentId') or None))
        return snake_to_camel(dept)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating department: {e}")
        raise HTTPException(status_code=500, detail="Failed to create department")


@router.put("/api/departments/{dept_id}")
def update_department(dept_id: str, payload: dict = Body(...), me: Identity = Depends(require_admin)):
    """Обновить отдел (имя/цвет/порядок). id остаётся стабильным."""
    updates = {}
    if 'name' in payload:
        updates['name'] = payload['name']
    if 'color' in payload:
        updates['color'] = payload['color']
    if 'order' in payload:
        updates['order'] = payload['order']
    if 'parentId' in payload:
        updates['parentId'] = payload['parentId'] or None
    try:
        dept = db.update_department(dept_id, updates)
        if not dept:
            raise HTTPException(status_code=404, detail="Отдел не найден")
        return snake_to_camel(dept)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating department {dept_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update department")


@router.delete("/api/departments/{dept_id}")
def delete_department(dept_id: str, me: Identity = Depends(require_admin)):
    """Удалить отдел. Запрещено, пока в нём остаются сотрудники."""
    try:
        db.delete_department(dept_id)
        return {"success": True}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(f"Error deleting department {dept_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete department")


# Клиент v2 шлёт PUT/DELETE на /api/departments?id=… (так было у старого фронта) —
# принимаем оба вида адреса.
@router.put("/api/departments")
def update_department_by_query(id: str, payload: dict = Body(...), me: Identity = Depends(require_admin)):
    return update_department(id, payload, me)


@router.delete("/api/departments")
def delete_department_by_query(id: str, me: Identity = Depends(require_admin)):
    return delete_department(id, me)
