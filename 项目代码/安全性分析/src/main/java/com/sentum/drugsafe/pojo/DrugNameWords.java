package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/***
 * 药品同义词（包含药品的剂型）
 * @author wangxm
 * @since 1.0
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class DrugNameWords {
    /**
     * 英文有效成分
     */
    private String standardName;
    /**
     * 中文有效成分
     */
    private String zhStandardName;
    /**
     * 当前有效成分的同义词，包含剂型
     */
    private List<String> words;
}
