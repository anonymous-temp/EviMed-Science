package com.sentum.drugsafe.trans;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 翻译内容超长，断句分次请求
 * @author zgm
 */
public class SplitTransUtils {
    public static int splitTrans(String content){
        List<Integer> posList = new ArrayList<>();
        //取句子结束符的位置（.|。|?|？|!|！）
        String[] strArray = {".","。","?","？","!","！"};
        for (String s : strArray) {
            int pos = content.lastIndexOf(s, 6000);
            posList.add(pos);
        }
        //取结束符的最大位置
        int max = Collections.max(posList);
        if (max < 0) {
            //未找到句子结束符，则查找最后一个逗号的位置
            max = content.lastIndexOf(",", 6000);
            //不存在逗号，则查找空格
            if (max < 0) {
                max = content.lastIndexOf(" ", 6000);
            }
            //不存在任何分隔符，则按长度6000取
            if (max < 0) {
                max = 6000;
            }
        }
        return max;
    }
}
