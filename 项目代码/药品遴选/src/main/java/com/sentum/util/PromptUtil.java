package com.sentum.util;

import com.sentum.annotation.PromptAnnotation;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.TraditionalInfoDto;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.BeanWrapper;
import org.springframework.beans.BeanWrapperImpl;

import java.beans.PropertyDescriptor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Slf4j
public class PromptUtil {

    public static String replacePrompt(String prompt, TraditionalInfoDto drugToModel){
        final BeanWrapper src = new BeanWrapperImpl(drugToModel);
        Map<String, Object> map = new HashMap<>();

        // 获取所有可读属性的名字
        PropertyDescriptor[] propertyNames = src.getPropertyDescriptors();

        for (PropertyDescriptor propertyName : propertyNames) {

            if (prompt.contains("${"+propertyName.getName()+"}")){
                String propertyValue = propertyName.getName();
                try {
                     propertyValue = src.getPropertyValue(propertyName.getName()).toString();
                }catch (Exception e){
                    log.error("promptUtil replacePrompt error: "+propertyName.getName());
                }


                if (StringUtils.isNotEmpty(propertyValue)){
                    prompt = prompt.replace("${"+propertyName.getName()+"}",propertyValue);
                }

            }
        }

        return prompt;
    }

    public static String replacePrompt(String prompt, DrugInfoNew drugToModel){
        final BeanWrapper src = new BeanWrapperImpl(drugToModel);
        Map<String, Object> map = new HashMap<>();

        // 获取所有可读属性的名字
        PropertyDescriptor[] propertyNames = src.getPropertyDescriptors();

        for (PropertyDescriptor propertyName : propertyNames) {

            if (prompt.contains("${"+propertyName.getName()+"}")){
                String propertyValue = propertyName.getName();
                try {
                    propertyValue = src.getPropertyValue(propertyName.getName()).toString();
                }catch (Exception e){
                    log.error("promptUtil replacePrompt error: "+propertyName.getName());
                }


                if (StringUtils.isNotEmpty(propertyValue)){
                    prompt = prompt.replace("${"+propertyName.getName()+"}",propertyValue);
                }

            }
        }

        return prompt;
    }


    public static String replacePrompt(String prompt,DrugInfoNew drugToModel, String x){
       prompt = prompt.replace("${}",x);
        final BeanWrapper src = new BeanWrapperImpl(drugToModel);
        Map<String, Object> map = new HashMap<>();

        // 获取所有可读属性的名字
        PropertyDescriptor[] propertyNames = src.getPropertyDescriptors();

        for (PropertyDescriptor propertyName : propertyNames) {

            if (prompt.contains("${"+propertyName.getName()+"}")){
                String propertyValue = propertyName.getName();
                try {
                    propertyValue = src.getPropertyValue(propertyName.getName()).toString();
                }catch (Exception e){
                    log.error("promptUtil replacePrompt error: "+propertyName.getName());
                }


                if (StringUtils.isNotEmpty(propertyValue)){
                    prompt = prompt.replace("${"+propertyName.getName()+"}",propertyValue);
                }

            }
        }

        return prompt;
    }


    /**
     * 根据自定义注解获取字段内容
     * @param obj
     * @param annotationClass
     * @param fieldName
     * @return
     */
     public static Object getFieldsWithAnnotation(Object obj, Class<? extends java.lang.annotation.Annotation> annotationClass,String fieldName) {

        Class<?> clazz = obj.getClass();
        Field[] fields = clazz.getDeclaredFields();

        for (Field field : fields) {
            if (field.isAnnotationPresent(annotationClass)) {
                PromptAnnotation promptAnnotation = field.getAnnotation(PromptAnnotation.class);
                try {
                    if (fieldName.equals(promptAnnotation.value())){
                         field.setAccessible(true);
                    return  field.get(obj);
                    }

                } catch (IllegalAccessException e) {
                    e.printStackTrace();
                }
            }
        }
        return null;

    }



    public static StringBuilder montageForPaper(StringBuilder query, List<String> inner, String type) {
        query.append("(");
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                String[] split = type.split(",");
                for (int j = 0; j < split.length; j++) {
                    query.append(s).append("[").append(split[j]).append("]");
                    if (j < split.length - 1) {
                        query.append(" OR ");
                    }
                }
            } else {
                query.append(s);
            }
            query.append(" OR ");
        }
        
        String[] split = type.split(",");
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            if (split.length > 1) {
                for (int j = 0; j < split.length; j++) {
                    query.append(s).append("[").append(split[j]).append("]");
                    if (j < split.length - 1) {
                        query.append(" OR ");
                    }
                }
            } else {
                for (String string : split) {
                    query.append(s).append("[").append(string).append("]");
                }
            }
        } else {
            query.append(s);
        }
        query.append(")");
        return query;
    }


    public static StringBuilder montageForPaper( List<String> inner, String type) {
         StringBuilder query = new StringBuilder();
        query.append("(");
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                String[] split = type.split(",");
                for (int j = 0; j < split.length; j++) {
                    query.append(s).append("[").append(split[j]).append("]");
                    if (j < split.length - 1) {
                        query.append(" OR ");
                    }
                }
            } else {
                query.append(s);
            }
            query.append(" OR ");
        }
        String[] split = type.split(",");
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            if (split.length > 1) {
                for (int j = 0; j < split.length; j++) {
                    query.append(s).append("[").append(split[j]).append("]");
                    if (j < split.length - 1) {
                        query.append(" OR ");
                    }
                }
            } else {
                for (String string : split) {
                    query.append(s).append("[").append(string).append("]");
                }
            }
        } else {
            query.append(s);
        }
        query.append(")");
        return query;
    }

    public static StringBuilder montageForPaper(StringBuilder query, String title, String type) {
        query.append("(");
        ArrayList<String> inner = new ArrayList<>();
        inner.add(title);

        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                query.append(s).append("[").append(type).append("]").append(" OR ");
            } else {
                query.append(s).append(" OR ");
            }
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            query.append(s).append("[").append(type).append("]");
        } else {
            query.append(s);
        }
        query.append(")");
        return query;
    }

}
