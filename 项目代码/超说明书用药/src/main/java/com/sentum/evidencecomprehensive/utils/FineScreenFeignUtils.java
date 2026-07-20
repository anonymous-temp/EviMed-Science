package com.sentum.evidencecomprehensive.utils;

import com.alibaba.fastjson.JSONException;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.feign.FormulaFeign;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * 远程调用检索中台
 */
@Slf4j
@Component
public class FineScreenFeignUtils {
    @Autowired
    private FineScreenFeign fineScreenFeign;
    public static FineScreenFeign fineScreen;

    @PostConstruct
    public void getFineScreenFeign(){
        fineScreen = this.fineScreenFeign;
    }

    public static String deepL(String word) {
        JSONObject wordDeepL = new JSONObject();
        wordDeepL.put("word", word);
        String transResult = "";
        try {
            transResult = fineScreen.deepl(wordDeepL);
        } catch (JSONException e) {
            log.error(e.getMessage(), e);
        }
        
        return transResult;
    }
}
