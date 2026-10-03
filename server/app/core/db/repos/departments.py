from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.db.connection import slugify_department

logger = logging.getLogger(__name__)


class DepartmentsRepo:
    """Запросы области «departments». Требует self.conn (PostgresConnection)."""

    def _ensure_departments_columns(self):
        """Idempotent schema guard: the departments table exists and carries parent_id
        (sub-departments — a department can nest one level under another, e.g. a
        "Продукт" department with several подразделы). Additive, safe to run always."""
        try:
            self.conn.execute_query(
                "ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_id VARCHAR(255)"
            )
        except Exception as e:
            logger.debug(f"[schema] _ensure_departments_columns failed: {e}")

    def get_departments(self) -> List[Dict[str, Any]]:
        """Get departments from the real departments table, with live employee counts.
        parent_id (parentId) is the id of the parent department for a sub-department,
        or NULL for a top-level one."""
        self._ensure_departments_columns()
        query = """
            SELECT d.id, d.name, d.color, d.order_num as "order", d.parent_id as "parentId",
                   COUNT(u.id) as employee_count
            FROM departments d
            LEFT JOIN users u ON u.department = d.id
            GROUP BY d.id, d.name, d.color, d.order_num, d.parent_id
            ORDER BY d.order_num, d.name
        """
        results = self.conn.fetch_all(query)
        return [dict(row) for row in results]

    def add_department(self, name: str, color: Optional[str] = None, parent_id: Optional[str] = None) -> Dict[str, Any]:
        """Create a department. Id is derived from name and must be unique. parent_id,
        if given, nests it under an existing TOP-LEVEL department (one level only)."""
        self._ensure_departments_columns()
        dept_id = slugify_department(name)
        existing = self.conn.fetch_one("SELECT id FROM departments WHERE id = %s", (dept_id,))
        if existing:
            raise ValueError(f"Отдел с похожим названием уже существует: {dept_id}")

        parent_id = (parent_id or None)
        if parent_id:
            parent = self.get_department(parent_id)
            if not parent:
                raise ValueError("Родительский отдел не найден")
            if parent.get('parentId'):
                raise ValueError("Нельзя вложить подраздел в подраздел — поддерживается один уровень")

        order_row = self.conn.fetch_one("SELECT COALESCE(MAX(order_num), -1) + 1 as next_order FROM departments")
        next_order = order_row['next_order'] if order_row else 0

        query = """
            INSERT INTO departments (id, name, color, order_num, parent_id)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, name, color, order_num as "order", parent_id as "parentId"
        """
        result = self.conn.fetch_one(query, (dept_id, name, color or '#6b7280', next_order, parent_id))
        return dict(result)

    def update_department(self, dept_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update a department's name/color/order/parent. Id is stable and never changes."""
        self._ensure_departments_columns()
        # Re-parenting guardrails: a department can't be its own parent, its parent must
        # exist and itself be top-level, and a department that already has children can't
        # become a sub-department (would create a 3rd level).
        if 'parentId' in updates:
            new_parent = updates['parentId'] or None
            if new_parent:
                if new_parent == dept_id:
                    raise ValueError("Отдел не может быть родителем самому себе")
                parent = self.get_department(new_parent)
                if not parent:
                    raise ValueError("Родительский отдел не найден")
                if parent.get('parentId'):
                    raise ValueError("Нельзя вложить подраздел в подраздел — поддерживается один уровень")
                child_row = self.conn.fetch_one("SELECT COUNT(*) as c FROM departments WHERE parent_id = %s", (dept_id,))
                if (child_row['c'] if child_row else 0) > 0:
                    raise ValueError("У отдела есть подразделы — его нельзя сделать подразделом")
            updates = {**updates, 'parentId': new_parent}

        set_clauses = []
        params: List[Any] = []
        field_map = {'name': 'name', 'color': 'color', 'order': 'order_num', 'parentId': 'parent_id'}
        for key, db_key in field_map.items():
            if key in updates:
                set_clauses.append(f"{db_key} = %s")
                params.append(updates[key])

        if not set_clauses:
            return self.get_department(dept_id)

        set_clauses.append("updated_at = NOW()")
        params.append(dept_id)
        query = f"""
            UPDATE departments SET {', '.join(set_clauses)}
            WHERE id = %s
            RETURNING id, name, color, order_num as "order", parent_id as "parentId"
        """
        result = self.conn.fetch_one(query, tuple(params))
        return dict(result) if result else None

    def get_department(self, dept_id: str) -> Optional[Dict[str, Any]]:
        self._ensure_departments_columns()
        result = self.conn.fetch_one(
            'SELECT id, name, color, order_num as "order", parent_id as "parentId" FROM departments WHERE id = %s',
            (dept_id,)
        )
        return dict(result) if result else None

    def delete_department(self, dept_id: str) -> None:
        """Delete a department. Refuses if any user is still assigned to it, or if it
        still has sub-departments (delete/reassign those first)."""
        self._ensure_departments_columns()
        count_row = self.conn.fetch_one("SELECT COUNT(*) as c FROM users WHERE department = %s", (dept_id,))
        employee_count = count_row['c'] if count_row else 0
        if employee_count > 0:
            raise ValueError(f"Нельзя удалить отдел: в нём ещё {employee_count} сотрудник(ов). Сначала переназначьте их.")
        child_row = self.conn.fetch_one("SELECT COUNT(*) as c FROM departments WHERE parent_id = %s", (dept_id,))
        child_count = child_row['c'] if child_row else 0
        if child_count > 0:
            raise ValueError(f"Нельзя удалить отдел: в нём ещё {child_count} подраздел(ов). Сначала удалите или перенесите их.")
        self.conn.execute_query("DELETE FROM departments WHERE id = %s", (dept_id,))
