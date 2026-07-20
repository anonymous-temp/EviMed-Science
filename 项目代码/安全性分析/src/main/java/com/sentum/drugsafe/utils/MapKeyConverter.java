package com.sentum.drugsafe.utils;

import java.util.HashMap;
import java.util.Map;

public class MapKeyConverter {

    public static void main(String[] args) {
        Map<String, Object> originalMap = new HashMap<>();
        originalMap.put("first_name", "John");
        originalMap.put("last_name", "Doe");
        originalMap.put("email_address", "johndoe@example.com");

        Map<String, Object> camelCaseMap = convertKeysToCamelCase(originalMap);
        camelCaseMap.forEach((key, value) -> System.out.println(key + ": " + value));
    }

    public static Map<String, Object> convertKeysToCamelCase(Map<String, Object> originalMap) {
        Map<String, Object> camelCaseMap = new HashMap<>();
        for (Map.Entry<String, Object> entry : originalMap.entrySet()) {
            String camelCaseKey = toCamelCase(entry.getKey());
            camelCaseMap.put(camelCaseKey, entry.getValue());
        }
        return camelCaseMap;
    }

    private static String toCamelCase(String underscoreStr) {
        StringBuilder camelCaseStr = new StringBuilder();
        boolean nextCharUpperCase = false;
        for (char c : underscoreStr.toCharArray()) {
            if (c == '_') {
                nextCharUpperCase = true;
            } else {
                if (nextCharUpperCase) {
                    camelCaseStr.append(Character.toUpperCase(c));
                    nextCharUpperCase = false;
                } else {
                    camelCaseStr.append(c);
                }
            }
        }
        return camelCaseStr.toString();
    }
}
