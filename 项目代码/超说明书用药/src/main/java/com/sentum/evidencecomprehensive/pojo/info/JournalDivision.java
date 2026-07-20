package com.sentum.evidencecomprehensive.pojo.info;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 期刊类型勾选
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("期刊类型勾选接收类")
public class JournalDivision {
    @ApiModelProperty("用户勾选的期刊名称")
    private String journal;
    @ApiModelProperty("用户勾选的期刊等级")
    private List<String> journalDivision;
}
