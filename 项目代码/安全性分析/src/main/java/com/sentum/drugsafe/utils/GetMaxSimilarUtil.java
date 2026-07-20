package com.sentum.drugsafe.utils;

import lombok.extern.slf4j.Slf4j;

/**
 * 得到一个词与标准词库最相似的词，阈值0.6
 * @author zgm
 */
@Slf4j
public class GetMaxSimilarUtil {

    /**
     * 判断输入的词是中文还是英文
     * @param str 需要判断的词
     * @return 中文为true，英文为false
     */
    public static boolean judgeChinese(String str){
        return str.getBytes().length != str.length();
    }
}
