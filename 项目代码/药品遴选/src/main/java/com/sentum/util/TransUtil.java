package com.sentum.util;


import com.alibaba.fastjson.JSONObject;
import com.sentum.feign.FineScreenFeign;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * 远程调用翻译
 */
@Component
public class TransUtil {

    @Autowired
    private FineScreenFeign fineScreenFeign;

    public static FineScreenFeign screenFeign;

    @PostConstruct
    public void getFineScreenFeign(){
        screenFeign = this.fineScreenFeign;
    }

    public static String trans(String word) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);
        try {
           return screenFeign.deepl(jsonObject);
        } catch (Exception e) {
            return "";
        }   
    }
}
