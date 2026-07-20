package com.evimed.agent.evidence.agentevidencebased.entity.index;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EsDocument;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class EsIndex {
    private static final Map<Class<?>, String> INDEX_CACHE = new ConcurrentHashMap<>();

    public static String of(Class<?> clazz) {
        return INDEX_CACHE.computeIfAbsent(clazz, c -> {
            EsDocument doc = c.getAnnotation(EsDocument.class);
            if (doc == null) {
                throw new IllegalArgumentException(
                        "实体类 " + c.getName() + " 缺少 @EsDocument 注解"
                );
            }
            return doc.index();
        });
    }
}
