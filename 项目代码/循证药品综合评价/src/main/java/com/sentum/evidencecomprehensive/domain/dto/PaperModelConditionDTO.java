package com.sentum.evidencecomprehensive.domain.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/24
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class PaperModelConditionDTO {
    @ApiModelProperty("检索式")
    private String mode;
    @ApiModelProperty(" 中英文扩展 1选中 0未选中")
    private String zhEnExtension;
    @ApiModelProperty("同义词扩展  1选中 0未选中")
    private String synonymExtension;
    @JsonIgnore
    private Long updateTime;
}
