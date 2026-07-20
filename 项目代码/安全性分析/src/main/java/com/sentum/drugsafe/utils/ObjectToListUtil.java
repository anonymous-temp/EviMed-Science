package com.sentum.drugsafe.utils;

import java.util.ArrayList;
import java.util.List;

/**
 * Java中Object转换为List类型
 * @author zgm
 */
public class ObjectToListUtil {
    public static <T> List<T> objToList(Object obj, Class<T> cla){
        if (obj == null){
            return new ArrayList<>();
        }
        List<T> list = new ArrayList<T>();
        for (Object o : (List<?>) obj) {
            list.add(cla.cast(o));
        }
        return list;
    }
}
