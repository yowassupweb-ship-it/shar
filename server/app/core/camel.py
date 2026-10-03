from __future__ import annotations


# Утилита для преобразования snake_case → camelCase
def snake_to_camel(data):
    """Рекурсивно преобразует ключи из snake_case в camelCase"""
    if isinstance(data, dict):
        preserve_nested_map_keys = {
            'read_messages_by_user',
            'read_at_by_user',
            'pinned_by_user',
            'pinned_order_by_user',
            'archived_by_user',
            'muted_by_user',
        }
        new_dict = {}
        for key, value in data.items():
            # Преобразуем ключ
            parts = key.split('_')
            camel_key = parts[0] + ''.join(word.capitalize() for word in parts[1:])
            
            # Специальная обработка для author_id: если None, заменяем на 'system'
            if camel_key == 'authorId' and value is None:
                new_dict[camel_key] = 'system'
            elif key in preserve_nested_map_keys and isinstance(value, dict):
                new_dict[camel_key] = value
            else:
                new_dict[camel_key] = snake_to_camel(value)
        
        # Обратная совместимость: isCompleted -> completed
        if 'isCompleted' in new_dict:
            new_dict['completed'] = new_dict['isCompleted']
        
        # Если есть metadata (задача из PostgreSQL), извлекаем поля в корень
        if 'metadata' in new_dict and isinstance(new_dict['metadata'], dict):
            metadata = new_dict['metadata']
            # Извлекаем важные поля из metadata в корень объекта
            if 'listId' in metadata:
                new_dict['listId'] = metadata['listId']
            if 'tags' in metadata:
                new_dict['tags'] = metadata['tags']
            if 'order' in metadata:
                new_dict['order'] = metadata['order']
            if 'archived' in metadata and 'archived' not in new_dict:
                new_dict['archived'] = metadata['archived']
            if 'completed' in metadata and 'completed' not in new_dict and 'isCompleted' not in new_dict:
                new_dict['completed'] = metadata['completed']
            if 'comments' in metadata:
                new_dict['comments'] = metadata['comments']
            # Reminder time / recurrence live in metadata (see the PUT stage_keys) — expose
            # them at the root so the task modal reads them back (otherwise the reminder
            # looked like it never saved).
            if 'reminderTime' in metadata and 'reminderTime' not in new_dict:
                new_dict['reminderTime'] = metadata['reminderTime']
            if 'recurrence' in metadata and 'recurrence' not in new_dict:
                new_dict['recurrence'] = metadata['recurrence']

        return new_dict
    elif isinstance(data, list):
        return [snake_to_camel(item) for item in data]
    else:
        return data


def snake_to_camel_list(items: list) -> list:
    return [snake_to_camel(i) for i in items]
